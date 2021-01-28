"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubServer = exports.uriHandler = exports.NETWORK_ERROR = void 0;
const nls = require("vscode-nls");
const vscode = require("vscode");
const node_fetch_1 = require("node-fetch");
const uuid_1 = require("uuid");
const utils_1 = require("./common/utils");
const logger_1 = require("./common/logger");
const localize = nls.loadMessageBundle();
exports.NETWORK_ERROR = 'network error';
const AUTH_RELAY_SERVER = 'vscode-auth.github.com';
class UriEventHandler extends vscode.EventEmitter {
    handleUri(uri) {
        this.fire(uri);
    }
}
exports.uriHandler = new UriEventHandler;
const onDidManuallyProvideToken = new vscode.EventEmitter();
function parseQuery(uri) {
    return uri.query.split('&').reduce((prev, current) => {
        const queryString = current.split('=');
        prev[queryString[0]] = queryString[1];
        return prev;
    }, {});
}
class GitHubServer {
    constructor() {
        this._pendingStates = new Map();
        this._codeExchangePromises = new Map();
        this.exchangeCodeForToken = (scopes) => async (uri, resolve, reject) => {
            logger_1.default.info('Exchanging code for token...');
            const query = parseQuery(uri);
            const code = query.code;
            const acceptedStates = this._pendingStates.get(scopes) || [];
            if (!acceptedStates.includes(query.state)) {
                reject('Received mismatched state');
                return;
            }
            try {
                const result = await node_fetch_1.default(`https://${AUTH_RELAY_SERVER}/token?code=${code}&state=${query.state}`, {
                    method: 'POST',
                    headers: {
                        Accept: 'application/json'
                    }
                });
                if (result.ok) {
                    const json = await result.json();
                    logger_1.default.info('Token exchange success!');
                    resolve(json.access_token);
                }
                else {
                    reject(result.statusText);
                }
            }
            catch (ex) {
                reject(ex);
            }
        };
    }
    isTestEnvironment(url) {
        return url.authority === 'vscode-web-test-playground.azurewebsites.net' || url.authority.startsWith('localhost:');
    }
    async login(scopes) {
        logger_1.default.info('Logging in...');
        this.updateStatusBarItem(true);
        const state = uuid_1.v4();
        const callbackUri = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://vscode.github-authentication/did-authenticate`));
        if (this.isTestEnvironment(callbackUri)) {
            const token = await vscode.window.showInputBox({ prompt: 'GitHub Personal Access Token', ignoreFocusOut: true });
            if (!token) {
                throw new Error('Sign in failed: No token provided');
            }
            const tokenScopes = await this.getScopes(token); // Example: ['repo', 'user']
            const scopesList = scopes.split(' '); // Example: 'read:user repo user:email'
            if (!scopesList.every(scope => {
                const included = tokenScopes.includes(scope);
                if (included || !scope.includes(':')) {
                    return included;
                }
                return scope.split(':').some(splitScopes => {
                    return tokenScopes.includes(splitScopes);
                });
            })) {
                throw new Error(`The provided token is does not match the requested scopes: ${scopes}`);
            }
            this.updateStatusBarItem(false);
            return token;
        }
        else {
            const existingStates = this._pendingStates.get(scopes) || [];
            this._pendingStates.set(scopes, [...existingStates, state]);
            const uri = vscode.Uri.parse(`https://${AUTH_RELAY_SERVER}/authorize/?callbackUri=${encodeURIComponent(callbackUri.toString())}&scope=${scopes}&state=${state}&responseType=code&authServer=https://github.com`);
            await vscode.env.openExternal(uri);
        }
        // Register a single listener for the URI callback, in case the user starts the login process multiple times
        // before completing it.
        let existingPromise = this._codeExchangePromises.get(scopes);
        if (!existingPromise) {
            existingPromise = utils_1.promiseFromEvent(exports.uriHandler.event, this.exchangeCodeForToken(scopes));
            this._codeExchangePromises.set(scopes, existingPromise);
        }
        return Promise.race([
            existingPromise,
            utils_1.promiseFromEvent(onDidManuallyProvideToken.event, (token) => { if (!token) {
                throw new Error('Cancelled');
            } return token; })
        ]).finally(() => {
            this._pendingStates.delete(scopes);
            this._codeExchangePromises.delete(scopes);
            this.updateStatusBarItem(false);
        });
    }
    updateStatusBarItem(isStart) {
        if (isStart && !this._statusBarItem) {
            this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            this._statusBarItem.text = localize('signingIn', "$(mark-github) Signing in to github.com...");
            this._statusBarItem.command = 'github.provide-token';
            this._statusBarItem.show();
        }
        if (!isStart && this._statusBarItem) {
            this._statusBarItem.dispose();
            this._statusBarItem = undefined;
        }
    }
    async manuallyProvideToken() {
        const uriOrToken = await vscode.window.showInputBox({ prompt: 'Token', ignoreFocusOut: true });
        if (!uriOrToken) {
            onDidManuallyProvideToken.fire(undefined);
            return;
        }
        try {
            const uri = vscode.Uri.parse(uriOrToken);
            if (!uri.scheme || uri.scheme === 'file') {
                throw new Error;
            }
            exports.uriHandler.handleUri(uri);
        }
        catch (e) {
            // If it doesn't look like a URI, treat it as a token.
            logger_1.default.info('Treating input as token');
            onDidManuallyProvideToken.fire(uriOrToken);
        }
    }
    async getScopes(token) {
        try {
            logger_1.default.info('Getting token scopes...');
            const result = await node_fetch_1.default('https://api.github.com', {
                headers: {
                    Authorization: `token ${token}`,
                    'User-Agent': 'Visual-Studio-Code'
                }
            });
            if (result.ok) {
                const scopes = result.headers.get('X-OAuth-Scopes');
                return scopes ? scopes.split(',').map(scope => scope.trim()) : [];
            }
            else {
                logger_1.default.error(`Getting scopes failed: ${result.statusText}`);
                throw new Error(result.statusText);
            }
        }
        catch (ex) {
            logger_1.default.error(ex.message);
            throw new Error(exports.NETWORK_ERROR);
        }
    }
    async getUserInfo(token) {
        let result;
        try {
            logger_1.default.info('Getting user info...');
            result = await node_fetch_1.default('https://api.github.com/user', {
                headers: {
                    Authorization: `token ${token}`,
                    'User-Agent': 'Visual-Studio-Code'
                }
            });
        }
        catch (ex) {
            logger_1.default.error(ex.message);
            throw new Error(exports.NETWORK_ERROR);
        }
        if (result.ok) {
            const json = await result.json();
            logger_1.default.info('Got account info!');
            return { id: json.id, accountName: json.login };
        }
        else {
            logger_1.default.error(`Getting account info failed: ${result.statusText}`);
            throw new Error(result.statusText);
        }
    }
}
exports.GitHubServer = GitHubServer;
//# sourceMappingURL=githubServer.js.map