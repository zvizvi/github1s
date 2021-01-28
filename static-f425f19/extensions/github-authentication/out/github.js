"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubAuthenticationProvider = exports.onDidChangeSessions = void 0;
const vscode = require("vscode");
const uuid_1 = require("uuid");
const keychain_1 = require("./common/keychain");
const githubServer_1 = require("./githubServer");
const logger_1 = require("./common/logger");
exports.onDidChangeSessions = new vscode.EventEmitter();
class GitHubAuthenticationProvider {
    constructor() {
        this._sessions = [];
        this._githubServer = new githubServer_1.GitHubServer();
    }
    async initialize(context) {
        try {
            this._sessions = await this.readSessions();
            await this.verifySessions();
        }
        catch (e) {
            // Ignore, network request failed
        }
        context.subscriptions.push(vscode.authentication.onDidChangePassword(() => this.checkForUpdates()));
    }
    async verifySessions() {
        const verifiedSessions = [];
        const verificationPromises = this._sessions.map(async (session) => {
            try {
                await this._githubServer.getUserInfo(session.accessToken);
                verifiedSessions.push(session);
            }
            catch (e) {
                // Remove sessions that return unauthorized response
                if (e.message !== 'Unauthorized') {
                    verifiedSessions.push(session);
                }
            }
        });
        Promise.all(verificationPromises).then(_ => {
            if (this._sessions.length !== verifiedSessions.length) {
                this._sessions = verifiedSessions;
                this.storeSessions();
            }
        });
    }
    async checkForUpdates() {
        let storedSessions;
        try {
            storedSessions = await this.readSessions();
        }
        catch (e) {
            // Ignore, network request failed
            return;
        }
        const added = [];
        const removed = [];
        storedSessions.forEach(session => {
            const matchesExisting = this._sessions.some(s => s.id === session.id);
            // Another window added a session to the keychain, add it to our state as well
            if (!matchesExisting) {
                logger_1.default.info('Adding session found in keychain');
                this._sessions.push(session);
                added.push(session.id);
            }
        });
        this._sessions.map(session => {
            const matchesExisting = storedSessions.some(s => s.id === session.id);
            // Another window has logged out, remove from our state
            if (!matchesExisting) {
                logger_1.default.info('Removing session no longer found in keychain');
                const sessionIndex = this._sessions.findIndex(s => s.id === session.id);
                if (sessionIndex > -1) {
                    this._sessions.splice(sessionIndex, 1);
                }
                removed.push(session.id);
            }
        });
        if (added.length || removed.length) {
            exports.onDidChangeSessions.fire({ added, removed, changed: [] });
        }
    }
    async readSessions() {
        const storedSessions = await keychain_1.keychain.getToken() || await keychain_1.keychain.tryMigrate();
        if (storedSessions) {
            try {
                const sessionData = JSON.parse(storedSessions);
                const sessionPromises = sessionData.map(async (session) => {
                    var _a, _b;
                    const needsUserInfo = !session.account;
                    let userInfo;
                    if (needsUserInfo) {
                        userInfo = await this._githubServer.getUserInfo(session.accessToken);
                    }
                    return {
                        id: session.id,
                        account: {
                            label: session.account
                                ? session.account.label || session.account.displayName
                                : userInfo.accountName,
                            id: (_b = (_a = session.account) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : userInfo.id
                        },
                        scopes: session.scopes,
                        accessToken: session.accessToken
                    };
                });
                return Promise.all(sessionPromises);
            }
            catch (e) {
                if (e === githubServer_1.NETWORK_ERROR) {
                    return [];
                }
                logger_1.default.error(`Error reading sessions: ${e}`);
                await keychain_1.keychain.deleteToken();
            }
        }
        return [];
    }
    async storeSessions() {
        await keychain_1.keychain.setToken(JSON.stringify(this._sessions));
    }
    get sessions() {
        return this._sessions;
    }
    async login(scopes) {
        const token = await this._githubServer.login(scopes);
        const session = await this.tokenToSession(token, scopes.split(' '));
        await this.setToken(session);
        return session;
    }
    async manuallyProvideToken() {
        this._githubServer.manuallyProvideToken();
    }
    async tokenToSession(token, scopes) {
        const userInfo = await this._githubServer.getUserInfo(token);
        return {
            id: uuid_1.v4(),
            accessToken: token,
            account: { label: userInfo.accountName, id: userInfo.id },
            scopes
        };
    }
    async setToken(session) {
        const sessionIndex = this._sessions.findIndex(s => s.id === session.id);
        if (sessionIndex > -1) {
            this._sessions.splice(sessionIndex, 1, session);
        }
        else {
            this._sessions.push(session);
        }
        await this.storeSessions();
    }
    async logout(id) {
        logger_1.default.info(`Logging out of ${id}`);
        const sessionIndex = this._sessions.findIndex(session => session.id === id);
        if (sessionIndex > -1) {
            this._sessions.splice(sessionIndex, 1);
        }
        else {
            logger_1.default.error('Session not found');
        }
        await this.storeSessions();
    }
}
exports.GitHubAuthenticationProvider = GitHubAuthenticationProvider;
//# sourceMappingURL=github.js.map