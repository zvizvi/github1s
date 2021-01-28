"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const github_1 = require("./github");
const githubServer_1 = require("./githubServer");
const logger_1 = require("./common/logger");
const vscode_extension_telemetry_1 = require("vscode-extension-telemetry");
async function activate(context) {
    const { name, version, aiKey } = require('../package.json');
    const telemetryReporter = new vscode_extension_telemetry_1.default(name, version, aiKey);
    context.subscriptions.push(vscode.window.registerUriHandler(githubServer_1.uriHandler));
    const loginService = new github_1.GitHubAuthenticationProvider();
    await loginService.initialize(context);
    context.subscriptions.push(vscode.commands.registerCommand('github.provide-token', () => {
        return loginService.manuallyProvideToken();
    }));
    context.subscriptions.push(vscode.authentication.registerAuthenticationProvider({
        id: 'github',
        label: 'GitHub',
        supportsMultipleAccounts: false,
        onDidChangeSessions: github_1.onDidChangeSessions.event,
        getSessions: () => Promise.resolve(loginService.sessions),
        login: async (scopeList) => {
            try {
                /* __GDPR__
                    "login" : { }
                */
                telemetryReporter.sendTelemetryEvent('login');
                const session = await loginService.login(scopeList.sort().join(' '));
                logger_1.default.info('Login success!');
                github_1.onDidChangeSessions.fire({ added: [session.id], removed: [], changed: [] });
                return session;
            }
            catch (e) {
                // If login was cancelled, do not notify user.
                if (e.message === 'Cancelled') {
                    /* __GDPR__
                        "loginCancelled" : { }
                    */
                    telemetryReporter.sendTelemetryEvent('loginCancelled');
                    throw e;
                }
                /* __GDPR__
                    "loginFailed" : { }
                */
                telemetryReporter.sendTelemetryEvent('loginFailed');
                vscode.window.showErrorMessage(`Sign in failed: ${e}`);
                logger_1.default.error(e);
                throw e;
            }
        },
        logout: async (id) => {
            try {
                /* __GDPR__
                    "logout" : { }
                */
                telemetryReporter.sendTelemetryEvent('logout');
                await loginService.logout(id);
                github_1.onDidChangeSessions.fire({ added: [], removed: [id], changed: [] });
            }
            catch (e) {
                /* __GDPR__
                    "logoutFailed" : { }
                */
                telemetryReporter.sendTelemetryEvent('logoutFailed');
                vscode.window.showErrorMessage(`Sign out failed: ${e}`);
                logger_1.default.error(e);
                throw e;
            }
        }
    }));
    return;
}
exports.activate = activate;
// this method is called when your extension is deactivated
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map