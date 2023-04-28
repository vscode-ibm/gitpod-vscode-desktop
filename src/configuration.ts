/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';

// Use these functions instead of `vscode.workspace.getConfiguration` API
// When activating the extension early with `onResolveRemoteAuthority:ssh-remote`, default values
// are not available yet and will return `undefined` so we hardcode the defaults here

function getGitpodHost() {
    return vscode.workspace.getConfiguration('gitpod').get<string>('host', 'https://gitpod.io/');
}

function getShowReleaseNotes() {
    return vscode.workspace.getConfiguration('gitpod').get<boolean>('showReleaseNotes', true);
}

function getUseLocalApp(useLocalSSHServer?: boolean) {
    if (useLocalSSHServer) {
        return false;
    }
    return vscode.workspace.getConfiguration('gitpod').get<boolean>('remote.useLocalApp', false);
}

function getLocalSSHServerPort() {
    // TODO(local-ssh): VSCodium?
    // use `sudo lsof -i:<port>` to check if the port is already in use
    let defaultPort = 42025;
    if (vscode.env.appName.includes('Insiders')) {
        defaultPort = 42026;
    }
    return vscode.workspace.getConfiguration('gitpod').get<number>('lsshPort', defaultPort) || defaultPort;
}

function getLocalSshIpcPort() {
    let defaultPort = 41025;
    if (vscode.env.appName.includes('Insiders')) {
        defaultPort = 41026;
    }
    return vscode.workspace.getConfiguration('gitpod').get<number>('lsshIpcPort', defaultPort) || defaultPort;
}

function getDaemonLogFileName(): string {
    if (vscode.env.appName.includes('Insiders')) {
        return 'gitpod-vscode-daemon-insiders.log';
    }
    return 'gitpod-vscode-daemon.log';
}

function getDaemonLogPath(): string {
    return join(tmpdir(), getDaemonLogFileName());
}

export const Configuration = {
    getGitpodHost,
    getShowReleaseNotes,
    getUseLocalApp,
    getLocalSSHServerPort,
    getLocalSshIpcPort,
    getDaemonLogPath,
    getDaemonLogFileName,
};