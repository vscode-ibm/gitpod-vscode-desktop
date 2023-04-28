/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ExtensionServiceDefinition, ExtensionServiceImplementation, GetWorkspaceAuthInfoRequest, GetWorkspaceAuthInfoResponse, LocalSSHServiceDefinition, PingRequest, SendErrorReportRequest, SendLocalSSHUserFlowStatusRequest, SendLocalSSHUserFlowStatusRequest_Code, SendLocalSSHUserFlowStatusRequest_ConnType, SendLocalSSHUserFlowStatusRequest_Status } from '../../proto/typescript/ipc/v1/ipc';
import { Disposable } from '../../common/dispose';
import { retry, timeout } from '../../common/async';
export { ExtensionServiceDefinition } from '../../proto/typescript/ipc/v1/ipc';
import { ensureDaemonStarted, killDaemon } from '../../daemonStarter';
import { withServerApi } from '../../internalApi';
import { Workspace, WorkspaceInstanceStatus_Phase } from '@gitpod/public-api/lib/gitpod/experimental/v1';
import { WorkspaceInfo, WorkspaceInstancePhase } from '@gitpod/gitpod-protocol';
import { ILogService } from '../../services/logService';
import { ISessionService } from '../../services/sessionService';
import { CallContext, ServerError, Status } from 'nice-grpc-common';
import { IHostService } from '../../services/hostService';
import { Server, createClient, createServer, createChannel } from 'nice-grpc';
import { INotificationService } from '../../services/notificationService';
import { getGitpodRemoteWindowConnectionInfo, showWsNotRunningDialog } from '../../remote';
import { ITelemetryService, UserFlowTelemetry } from '../../services/telemetryService';
import { ExperimentalSettings } from '../../experiments';
import { Configuration } from '../../configuration';
import { SemVer } from 'semver';

const phaseMap: Record<WorkspaceInstanceStatus_Phase, WorkspaceInstancePhase | undefined> = {
    [WorkspaceInstanceStatus_Phase.CREATING]: 'pending',
    [WorkspaceInstanceStatus_Phase.IMAGEBUILD]: 'building',
    [WorkspaceInstanceStatus_Phase.INITIALIZING]: 'initializing',
    [WorkspaceInstanceStatus_Phase.INTERRUPTED]: 'running',
    [WorkspaceInstanceStatus_Phase.PENDING]: 'stopping',
    [WorkspaceInstanceStatus_Phase.PREPARING]: 'stopped',
    [WorkspaceInstanceStatus_Phase.RUNNING]: 'running',
    [WorkspaceInstanceStatus_Phase.STOPPED]: 'stopped',
    [WorkspaceInstanceStatus_Phase.STOPPING]: 'stopping',
    [WorkspaceInstanceStatus_Phase.UNSPECIFIED]: undefined,
};

export class ExtensionServiceImpl implements ExtensionServiceImplementation {
    private notificationGapSet = new Set<string>();

    constructor(private readonly context: vscode.ExtensionContext, private logService: ILogService, private sessionService: ISessionService, private hostService: IHostService, private notificationService: INotificationService, private experiments: ExperimentalSettings, private telemetryService: ITelemetryService) { }

    private canShowNotification(id: string) {
        let remoteConnectionInfo = getGitpodRemoteWindowConnectionInfo(this.context);
        if (!remoteConnectionInfo || remoteConnectionInfo.connectionInfo.workspaceId !== id) {
            return false;
        }
        if (this.notificationGapSet.has(id)) {
            return false;
        }
        this.notificationGapSet.add(id);
        setTimeout(() => {
            this.notificationGapSet.delete(id);
        }, 10000); // clean gap after 10s
        return true;
    }

    async ping(_request: PingRequest, _context: CallContext): Promise<{}> {
        return {};
    }

    async getWorkspaceAuthInfo(request: GetWorkspaceAuthInfoRequest, _context: CallContext): Promise<GetWorkspaceAuthInfoResponse> {
        try {
            await this.sessionService.didFirstLoad;
            const accessToken = this.sessionService.getGitpodToken();
            if (!accessToken) {
                throw new ServerError(Status.INTERNAL, 'no access token found');
            }
            const userId = this.sessionService.getUserId();
            const workspaceId = request.workspaceId;

            const gitpodHost = this.hostService.gitpodHost;
            const usePublicApi = await this.experiments.getUsePublicAPI(gitpodHost);
            const [workspace, ownerToken] = await withServerApi(accessToken, gitpodHost, svc => Promise.all([
                usePublicApi ? this.sessionService.getAPI().getWorkspace(workspaceId) : svc.server.getWorkspace(workspaceId),
                usePublicApi ? this.sessionService.getAPI().getOwnerToken(workspaceId) : svc.server.getOwnerToken(workspaceId),
            ]), this.logService);

            const phase = usePublicApi ? phaseMap[(workspace as Workspace).status?.instance?.status?.phase ?? WorkspaceInstanceStatus_Phase.UNSPECIFIED] : (workspace as WorkspaceInfo).latestInstance?.status.phase;
            if (phase !== 'running') {
                const show = this.canShowNotification(workspaceId);
                if (show) {
                    const flow: UserFlowTelemetry = { workspaceId, gitpodHost, userId: userId, flow: 'extension_ipc' };
                    showWsNotRunningDialog(workspaceId, gitpodHost, flow, this.notificationService, this.logService);
                }
                throw new ServerError(Status.UNAVAILABLE, 'workspace is not running, current phase: ' + phase);
            }

            const ideUrl = usePublicApi ? (workspace as Workspace).status?.instance?.status?.url : (workspace as WorkspaceInfo).latestInstance?.ideUrl;
            if (!ideUrl) {
                throw new ServerError(Status.DATA_LOSS, 'no ide url found');
            }
            const url = new URL(ideUrl);
            const workspaceHost = url.host.substring(url.host.indexOf('.') + 1);
            const instanceId = (usePublicApi ? (workspace as Workspace).status?.instance?.instanceId : (workspace as WorkspaceInfo).latestInstance?.id) as string;
            return {
                gitpodHost,
                userId,
                workspaceId,
                instanceId,
                workspaceHost,
                ownerToken,
            };
        } catch (e) {
            this.logService.error(e, 'failed to get workspace auth info');
            throw e;
        }
    }

    // TODO remove from protocol, don't pass sensitive info back and forth, only once for auth, daemon should do telemtry directly
    async sendLocalSSHUserFlowStatus(request: SendLocalSSHUserFlowStatusRequest, _context: CallContext): Promise<{}> {
        const flow: UserFlowTelemetry = {
            flow: 'ssh',
            kind: 'local-ssh',
            connType: request.connType === SendLocalSSHUserFlowStatusRequest_ConnType.CONN_TYPE_SSH ? 'ssh' : 'tunnel',
            workspaceId: request.workspaceId,
            instanceId: request.instanceId,
            daemonVersion: request.daemonVersion,
            userId: request.userId,
            gitpodHost: request.gitpodHost,
            extensionVersion: request.extensionVersion,
        };
        if (request.status !== SendLocalSSHUserFlowStatusRequest_Status.STATUS_SUCCESS && request.failureCode !== SendLocalSSHUserFlowStatusRequest_Code.CODE_UNSPECIFIED) {
            flow.reason = request.failureReason; // TODO remove, should go to error reporting only
            flow.reasonCode = SendLocalSSHUserFlowStatusRequest_Code[request.failureCode];
        }
        const status = request.status === SendLocalSSHUserFlowStatusRequest_Status.STATUS_SUCCESS ? 'local-ssh-success' : 'local-ssh-failure';
        this.telemetryService.sendUserFlowStatus(status, flow);
        return {};
    }

    // TODO remove from protocol, don't pass sensitive info back and forth, only once for auth, daemon should do telemtry directly
    // local ssh daemon should be own component in reporting?
    async sendErrorReport(request: SendErrorReportRequest, _context: CallContext): Promise<{}> {
        const err = new Error(request.errorMessage);
        err.name = 'local-ssh:' + request.errorName;
        err.stack = request.errorStack;
        const properties: Record<string, any> = {
            workspaceId: request.workspaceId,
            instanceId: request.instanceId,
            daemonVersion: request.daemonVersion,
            extensionVersion: request.extensionVersion,
            userId: request.userId,
        };
        this.telemetryService.sendTelemetryException(request.gitpodHost, err, properties);
        return {};
    }
}

export class ExtensionServiceServer extends Disposable {
    static MAX_LOCAL_SSH_PING_RETRY_COUNT = 10;
    static MAX_EXTENSION_ACTIVE_RETRY_COUNT = 10;

    private server: Server;
    private pingLocalSSHRetryCount = 0;
    private lastTimeActiveTelemetry: boolean | undefined;
    private readonly id: string = Math.random().toString(36).slice(2);
    private ipcPort?: number;

    private localSSHServiceClient = createClient(LocalSSHServiceDefinition, createChannel('127.0.0.1:' + Configuration.getLocalSshIpcPort()));

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logService: ILogService,
        private readonly sessionService: ISessionService,
        private readonly hostService: IHostService,
        private readonly notificationService: INotificationService,
        private readonly telemetryService: ITelemetryService,
        private experiments: ExperimentalSettings,
    ) {
        super();
        this.server = this.getServer();
        this.tryForceKillZombieDaemon();
        this.tryActive();
        this.hostService.onDidChangeHost(() => {
            this.tryActive();
        });
    }

    private getServer(): Server {
        const server = createServer();
        const serviceImpl = new ExtensionServiceImpl(this.context, this.logService, this.sessionService, this.hostService, this.notificationService, this.experiments, this.telemetryService);
        server.add(ExtensionServiceDefinition, serviceImpl);
        return server;
    }

    private async tryActive() {
        this.logService.info('going to start extension ipc service server with id', this.id);
        this.server.listen('127.0.0.1:0').then((port) => {
            this.ipcPort = port;
            this.logService.info('extension ipc service server started to listen with id: ' + this.id);
            this.pingLocalSSHService();
            this.backoffActive();
        }).catch(e => {
            this.logService.error(e, `extension ipc service server failed to listen with id: ${this.id}`);
        });
    }

    private async backoffActive() {
        try {
            await retry(async () => {
                await this.localSSHServiceClient.active({ id: this.id, ipcPort: this.ipcPort! });
                this.logService.info('extension ipc svc activated id: ' + this.id);
            }, 200, ExtensionServiceServer.MAX_EXTENSION_ACTIVE_RETRY_COUNT);
            if (this.lastTimeActiveTelemetry === true) {
                return;
            }
            const userId = this.sessionService.safeGetUserId();
            this.telemetryService.sendRawTelemetryEvent(this.hostService.gitpodHost, 'vscode_desktop_extension_ipc_svc_active', { id: this.id, userId, active: true });
            this.lastTimeActiveTelemetry = true;
        } catch (e) {
            const gitpodHost = this.hostService.gitpodHost;
            const userId = this.sessionService.safeGetUserId();
            this.telemetryService.sendRawTelemetryEvent(gitpodHost, 'vscode_desktop_extension_ipc_svc_active', { id: this.id, userId, active: false });
            this.logService.warn(e, 'failed to active extension ipc svc');
            if (this.lastTimeActiveTelemetry === false) {
                return;
            }
            this.telemetryService.sendTelemetryException(gitpodHost, e, { userId } as any);
            this.lastTimeActiveTelemetry = false;
        }
    }

    public override dispose() {
        this.server.shutdown();
    }

    /**
     * pingLocalSSHService to see if it's still alive
     * if not, start a new one
     */
    private async pingLocalSSHService() {
        while (true) {
            if (this.pingLocalSSHRetryCount > ExtensionServiceServer.MAX_LOCAL_SSH_PING_RETRY_COUNT) {
                this.logService.error('failed to ping local ssh service for 10 times, stopping ping process');
                return;
            }
            try {
                await this.localSSHServiceClient.ping({});
                this.pingLocalSSHRetryCount = 0;
            } catch (err) {
                this.logService.error('failed to ping local ssh service, going to start a new one', err);
                ensureDaemonStarted(this.logService, this.telemetryService).catch(() => { });
                this.backoffActive();
                this.pingLocalSSHRetryCount++;
            }
            await timeout(1000 * 1);
        }
    }

    // private async notifyIfDaemonNeedsRestart() {
    //     const resp = await this.localSSHServiceClient.getDaemonVersion({});
    //     const runningVersion = new SemVer(resp.version);
    //     const wantedVersion = new SemVer(getDaemonVersion());
    //     if (runningVersion.compare(wantedVersion) >= 0) {
    //         return;
    //     }
    //     // TODO(local-ssh): allow to hide always for current version (wantedVersion)
    //     this.logService.info('restart vscode to get latest features of local ssh');
    //     // await this.notificationService.showWarningMessage('Restart VSCode to use latest local ssh daemon', { id: 'daemon_needs_restart', flow: { flow: 'daemon_needs_restart' } });
    // }

    private async tryForceKillZombieDaemon() {
        try {
            // force kill daemon if its version less than 0.0.3
            const resp = await this.localSSHServiceClient.getDaemonVersion({});
            const runningDaemonVersion = new SemVer(resp.version);
            if (runningDaemonVersion.compare(new SemVer('0.0.3')) >= 0) {
                return;
            }
            killDaemon(this.logService);
        } catch (e) {
            this.logService.error(e, 'failed to force kill zombie daemon');
        }
    }
}