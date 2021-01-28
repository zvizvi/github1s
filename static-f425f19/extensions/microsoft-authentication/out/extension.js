"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = exports.DEFAULT_SCOPES = void 0;
const vscode = require("vscode");
const AADHelper_1 = require("./AADHelper");
const vscode_extension_telemetry_1 = require("vscode-extension-telemetry");
exports.DEFAULT_SCOPES = 'https://management.core.windows.net/.default offline_access';
async function activate(context) {
    const { name, version, aiKey } = require('../package.json');
    const telemetryReporter = new vscode_extension_telemetry_1.default(name, version, aiKey);
    const loginService = new AADHelper_1.AzureActiveDirectoryService();
    context.subscriptions.push(loginService);
    await loginService.initialize();
    context.subscriptions.push(vscode.authentication.registerAuthenticationProvider({
        id: 'microsoft',
        label: 'Microsoft',
        supportsMultipleAccounts: true,
        onDidChangeSessions: AADHelper_1.onDidChangeSessions.event,
        getSessions: () => Promise.resolve(loginService.sessions),
        login: async (scopes) => {
            try {
                /* __GDPR__
                    "login" : { }
                */
                telemetryReporter.sendTelemetryEvent('login');
                const session = await loginService.login(scopes.sort().join(' '));
                AADHelper_1.onDidChangeSessions.fire({ added: [session.id], removed: [], changed: [] });
                return session;
            }
            catch (e) {
                /* __GDPR__
                    "loginFailed" : { }
                */
                telemetryReporter.sendTelemetryEvent('loginFailed');
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
                AADHelper_1.onDidChangeSessions.fire({ added: [], removed: [id], changed: [] });
            }
            catch (e) {
                /* __GDPR__
                    "logoutFailed" : { }
                */
                telemetryReporter.sendTelemetryEvent('logoutFailed');
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