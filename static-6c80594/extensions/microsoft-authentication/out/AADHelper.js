"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureActiveDirectoryService = exports.REFRESH_NETWORK_FAILURE = exports.onDidChangeSessions = void 0;
const randomBytes = require("randombytes");
const querystring = require("querystring");
const buffer_1 = require("buffer");
const vscode = require("vscode");
const authServer_1 = require("./authServer");
const uuid_1 = require("uuid");
const keychain_1 = require("./keychain");
const logger_1 = require("./logger");
const utils_1 = require("./utils");
const node_fetch_1 = require("node-fetch");
const sha256_1 = require("./env/node/sha256");
const nls = require("vscode-nls");
const localize = nls.loadMessageBundle();
const redirectUrl = 'https://vscode-redirect.azurewebsites.net/';
const loginEndpointUrl = 'https://login.microsoftonline.com/';
const clientId = 'aebc6443-996d-45c2-90f0-388ff96faa56';
const tenant = 'organizations';
function parseQuery(uri) {
    return uri.query.split('&').reduce((prev, current) => {
        const queryString = current.split('=');
        prev[queryString[0]] = queryString[1];
        return prev;
    }, {});
}
exports.onDidChangeSessions = new vscode.EventEmitter();
exports.REFRESH_NETWORK_FAILURE = 'Network failure';
class UriEventHandler extends vscode.EventEmitter {
    handleUri(uri) {
        this.fire(uri);
    }
}
class AzureActiveDirectoryService {
    constructor() {
        this._tokens = [];
        this._refreshTimeouts = new Map();
        this._disposables = [];
        // Used to keep track of current requests when not using the local server approach.
        this._pendingStates = new Map();
        this._codeExchangePromises = new Map();
        this._codeVerfifiers = new Map();
        this._uriHandler = new UriEventHandler();
        this._disposables.push(vscode.window.registerUriHandler(this._uriHandler));
    }
    async initialize() {
        const storedData = await keychain_1.keychain.getToken() || await keychain_1.keychain.tryMigrate();
        if (storedData) {
            try {
                const sessions = this.parseStoredData(storedData);
                const refreshes = sessions.map(async (session) => {
                    var _a;
                    if (!session.refreshToken) {
                        return Promise.resolve();
                    }
                    try {
                        await this.refreshToken(session.refreshToken, session.scope, session.id);
                    }
                    catch (e) {
                        if (e.message === exports.REFRESH_NETWORK_FAILURE) {
                            const didSucceedOnRetry = await this.handleRefreshNetworkError(session.id, session.refreshToken, session.scope);
                            if (!didSucceedOnRetry) {
                                this._tokens.push({
                                    accessToken: undefined,
                                    refreshToken: session.refreshToken,
                                    account: {
                                        label: (_a = session.account.label) !== null && _a !== void 0 ? _a : session.account.displayName,
                                        id: session.account.id
                                    },
                                    scope: session.scope,
                                    sessionId: session.id
                                });
                                this.pollForReconnect(session.id, session.refreshToken, session.scope);
                            }
                        }
                        else {
                            await this.logout(session.id);
                        }
                    }
                });
                await Promise.all(refreshes);
            }
            catch (e) {
                logger_1.default.info('Failed to initialize stored data');
                await this.clearSessions();
            }
        }
        this._disposables.push(vscode.authentication.onDidChangePassword(() => this.checkForUpdates));
    }
    parseStoredData(data) {
        return JSON.parse(data);
    }
    async storeTokenData() {
        const serializedData = this._tokens.map(token => {
            return {
                id: token.sessionId,
                refreshToken: token.refreshToken,
                scope: token.scope,
                account: token.account
            };
        });
        await keychain_1.keychain.setToken(JSON.stringify(serializedData));
    }
    async checkForUpdates() {
        const addedIds = [];
        let removedIds = [];
        const storedData = await keychain_1.keychain.getToken();
        if (storedData) {
            try {
                const sessions = this.parseStoredData(storedData);
                let promises = sessions.map(async (session) => {
                    const matchesExisting = this._tokens.some(token => token.scope === session.scope && token.sessionId === session.id);
                    if (!matchesExisting && session.refreshToken) {
                        try {
                            await this.refreshToken(session.refreshToken, session.scope, session.id);
                            addedIds.push(session.id);
                        }
                        catch (e) {
                            if (e.message === exports.REFRESH_NETWORK_FAILURE) {
                                // Ignore, will automatically retry on next poll.
                            }
                            else {
                                await this.logout(session.id);
                            }
                        }
                    }
                });
                promises = promises.concat(this._tokens.map(async (token) => {
                    const matchesExisting = sessions.some(session => token.scope === session.scope && token.sessionId === session.id);
                    if (!matchesExisting) {
                        await this.logout(token.sessionId);
                        removedIds.push(token.sessionId);
                    }
                }));
                await Promise.all(promises);
            }
            catch (e) {
                logger_1.default.error(e.message);
                // if data is improperly formatted, remove all of it and send change event
                removedIds = this._tokens.map(token => token.sessionId);
                this.clearSessions();
            }
        }
        else {
            if (this._tokens.length) {
                // Log out all, remove all local data
                removedIds = this._tokens.map(token => token.sessionId);
                logger_1.default.info('No stored keychain data, clearing local data');
                this._tokens = [];
                this._refreshTimeouts.forEach(timeout => {
                    clearTimeout(timeout);
                });
                this._refreshTimeouts.clear();
            }
        }
        if (addedIds.length || removedIds.length) {
            exports.onDidChangeSessions.fire({ added: addedIds, removed: removedIds, changed: [] });
        }
    }
    async convertToSession(token) {
        const resolvedToken = await this.resolveAccessToken(token);
        return {
            id: token.sessionId,
            accessToken: resolvedToken,
            account: token.account,
            scopes: token.scope.split(' ')
        };
    }
    async resolveAccessToken(token) {
        if (token.accessToken && (!token.expiresAt || token.expiresAt > Date.now())) {
            token.expiresAt
                ? logger_1.default.info(`Token available from cache, expires in ${token.expiresAt - Date.now()} milliseconds`)
                : logger_1.default.info('Token available from cache');
            return Promise.resolve(token.accessToken);
        }
        try {
            logger_1.default.info('Token expired or unavailable, trying refresh');
            const refreshedToken = await this.refreshToken(token.refreshToken, token.scope, token.sessionId);
            if (refreshedToken.accessToken) {
                return refreshedToken.accessToken;
            }
            else {
                throw new Error();
            }
        }
        catch (e) {
            throw new Error('Unavailable due to network problems');
        }
    }
    getTokenClaims(accessToken) {
        try {
            return JSON.parse(buffer_1.Buffer.from(accessToken.split('.')[1], 'base64').toString());
        }
        catch (e) {
            logger_1.default.error(e.message);
            throw new Error('Unable to read token claims');
        }
    }
    get sessions() {
        return Promise.all(this._tokens.map(token => this.convertToSession(token)));
    }
    async login(scope) {
        logger_1.default.info('Logging in...');
        if (!scope.includes('offline_access')) {
            logger_1.default.info('Warning: The \'offline_access\' scope was not included, so the generated token will not be able to be refreshed.');
        }
        return new Promise(async (resolve, reject) => {
            if (vscode.env.remoteName !== undefined) {
                resolve(this.loginWithoutLocalServer(scope));
                return;
            }
            const nonce = randomBytes(16).toString('base64');
            const { server, redirectPromise, codePromise } = authServer_1.createServer(nonce);
            let token;
            try {
                const port = await authServer_1.startServer(server);
                vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/signin?nonce=${encodeURIComponent(nonce)}`));
                const redirectReq = await redirectPromise;
                if ('err' in redirectReq) {
                    const { err, res } = redirectReq;
                    res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
                    res.end();
                    throw err;
                }
                const host = redirectReq.req.headers.host || '';
                const updatedPortStr = (/^[^:]+:(\d+)$/.exec(Array.isArray(host) ? host[0] : host) || [])[1];
                const updatedPort = updatedPortStr ? parseInt(updatedPortStr, 10) : port;
                const state = `${updatedPort},${encodeURIComponent(nonce)}`;
                const codeVerifier = utils_1.toBase64UrlEncoding(randomBytes(32).toString('base64'));
                const codeChallenge = utils_1.toBase64UrlEncoding(await sha256_1.sha256(codeVerifier));
                const loginUrl = `${loginEndpointUrl}${tenant}/oauth2/v2.0/authorize?response_type=code&response_mode=query&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&scope=${encodeURIComponent(scope)}&prompt=select_account&code_challenge_method=S256&code_challenge=${codeChallenge}`;
                await redirectReq.res.writeHead(302, { Location: loginUrl });
                redirectReq.res.end();
                const codeRes = await codePromise;
                const res = codeRes.res;
                try {
                    if ('err' in codeRes) {
                        throw codeRes.err;
                    }
                    token = await this.exchangeCodeForToken(codeRes.code, codeVerifier, scope);
                    this.setToken(token, scope);
                    logger_1.default.info('Login successful');
                    res.writeHead(302, { Location: '/' });
                    const session = await this.convertToSession(token);
                    resolve(session);
                    res.end();
                }
                catch (err) {
                    res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
                    res.end();
                    reject(err.message);
                }
            }
            catch (e) {
                logger_1.default.error(e.message);
                // If the error was about starting the server, try directly hitting the login endpoint instead
                if (e.message === 'Error listening to server' || e.message === 'Closed' || e.message === 'Timeout waiting for port') {
                    await this.loginWithoutLocalServer(scope);
                }
                reject(e.message);
            }
            finally {
                setTimeout(() => {
                    server.close();
                }, 5000);
            }
        });
    }
    dispose() {
        this._disposables.forEach(disposable => disposable.dispose());
        this._disposables = [];
    }
    getCallbackEnvironment(callbackUri) {
        if (callbackUri.authority.endsWith('.workspaces.github.com') || callbackUri.authority.endsWith('.github.dev')) {
            return `${callbackUri.authority},`;
        }
        switch (callbackUri.authority) {
            case 'online.visualstudio.com':
                return 'vso,';
            case 'online-ppe.core.vsengsaas.visualstudio.com':
                return 'vsoppe,';
            case 'online.dev.core.vsengsaas.visualstudio.com':
                return 'vsodev,';
            default:
                return `${callbackUri.scheme},`;
        }
    }
    async loginWithoutLocalServer(scope) {
        const callbackUri = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://vscode.microsoft-authentication`));
        const nonce = randomBytes(16).toString('base64');
        const port = (callbackUri.authority.match(/:([0-9]*)$/) || [])[1] || (callbackUri.scheme === 'https' ? 443 : 80);
        const callbackEnvironment = this.getCallbackEnvironment(callbackUri);
        const state = `${callbackEnvironment}${port},${encodeURIComponent(nonce)},${encodeURIComponent(callbackUri.query)}`;
        const signInUrl = `${loginEndpointUrl}${tenant}/oauth2/v2.0/authorize`;
        let uri = vscode.Uri.parse(signInUrl);
        const codeVerifier = utils_1.toBase64UrlEncoding(randomBytes(32).toString('base64'));
        const codeChallenge = utils_1.toBase64UrlEncoding(await sha256_1.sha256(codeVerifier));
        uri = uri.with({
            query: `response_type=code&client_id=${encodeURIComponent(clientId)}&response_mode=query&redirect_uri=${redirectUrl}&state=${state}&scope=${scope}&prompt=select_account&code_challenge_method=S256&code_challenge=${codeChallenge}`
        });
        vscode.env.openExternal(uri);
        const timeoutPromise = new Promise((_, reject) => {
            const wait = setTimeout(() => {
                clearTimeout(wait);
                reject('Login timed out.');
            }, 1000 * 60 * 5);
        });
        const existingStates = this._pendingStates.get(scope) || [];
        this._pendingStates.set(scope, [...existingStates, state]);
        // Register a single listener for the URI callback, in case the user starts the login process multiple times
        // before completing it.
        let existingPromise = this._codeExchangePromises.get(scope);
        if (!existingPromise) {
            existingPromise = this.handleCodeResponse(scope);
            this._codeExchangePromises.set(scope, existingPromise);
        }
        this._codeVerfifiers.set(state, codeVerifier);
        return Promise.race([existingPromise, timeoutPromise])
            .finally(() => {
            this._pendingStates.delete(scope);
            this._codeExchangePromises.delete(scope);
            this._codeVerfifiers.delete(state);
        });
    }
    async handleCodeResponse(scope) {
        let uriEventListener;
        return new Promise((resolve, reject) => {
            uriEventListener = this._uriHandler.event(async (uri) => {
                var _a;
                try {
                    const query = parseQuery(uri);
                    const code = query.code;
                    const acceptedStates = this._pendingStates.get(scope) || [];
                    // Workaround double encoding issues of state in web
                    if (!acceptedStates.includes(query.state) && !acceptedStates.includes(decodeURIComponent(query.state))) {
                        throw new Error('State does not match.');
                    }
                    const verifier = (_a = this._codeVerfifiers.get(query.state)) !== null && _a !== void 0 ? _a : this._codeVerfifiers.get(decodeURIComponent(query.state));
                    if (!verifier) {
                        throw new Error('No available code verifier');
                    }
                    const token = await this.exchangeCodeForToken(code, verifier, scope);
                    this.setToken(token, scope);
                    const session = await this.convertToSession(token);
                    resolve(session);
                }
                catch (err) {
                    reject(err);
                }
            });
        }).then(result => {
            uriEventListener.dispose();
            return result;
        }).catch(err => {
            uriEventListener.dispose();
            throw err;
        });
    }
    async setToken(token, scope) {
        const existingTokenIndex = this._tokens.findIndex(t => t.sessionId === token.sessionId);
        if (existingTokenIndex > -1) {
            this._tokens.splice(existingTokenIndex, 1, token);
        }
        else {
            this._tokens.push(token);
        }
        this.clearSessionTimeout(token.sessionId);
        if (token.expiresIn) {
            this._refreshTimeouts.set(token.sessionId, setTimeout(async () => {
                try {
                    await this.refreshToken(token.refreshToken, scope, token.sessionId);
                    exports.onDidChangeSessions.fire({ added: [], removed: [], changed: [token.sessionId] });
                }
                catch (e) {
                    if (e.message === exports.REFRESH_NETWORK_FAILURE) {
                        const didSucceedOnRetry = await this.handleRefreshNetworkError(token.sessionId, token.refreshToken, scope);
                        if (!didSucceedOnRetry) {
                            this.pollForReconnect(token.sessionId, token.refreshToken, token.scope);
                        }
                    }
                    else {
                        await this.logout(token.sessionId);
                        exports.onDidChangeSessions.fire({ added: [], removed: [token.sessionId], changed: [] });
                    }
                }
            }, 1000 * (token.expiresIn - 30)));
        }
        this.storeTokenData();
    }
    getTokenFromResponse(json, scope, existingId) {
        let claims = undefined;
        try {
            claims = this.getTokenClaims(json.access_token);
        }
        catch (e) {
            if (json.id_token) {
                logger_1.default.info('Failed to fetch token claims from access_token. Attempting to parse id_token instead');
                claims = this.getTokenClaims(json.id_token);
            }
            else {
                throw e;
            }
        }
        return {
            expiresIn: json.expires_in,
            expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
            scope,
            sessionId: existingId || `${claims.tid}/${(claims.oid || (claims.altsecid || '' + claims.ipd || ''))}/${uuid_1.v4()}`,
            account: {
                label: claims.email || claims.unique_name || claims.preferred_username || 'user@example.com',
                id: `${claims.tid}/${(claims.oid || (claims.altsecid || '' + claims.ipd || ''))}`
            }
        };
    }
    async exchangeCodeForToken(code, codeVerifier, scope) {
        logger_1.default.info('Exchanging login code for token');
        try {
            const postData = querystring.stringify({
                grant_type: 'authorization_code',
                code: code,
                client_id: clientId,
                scope: scope,
                code_verifier: codeVerifier,
                redirect_uri: redirectUrl
            });
            const proxyEndpoints = await vscode.commands.executeCommand('workbench.getCodeExchangeProxyEndpoints');
            const endpoint = proxyEndpoints && proxyEndpoints['microsoft'] || `${loginEndpointUrl}${tenant}/oauth2/v2.0/token`;
            const result = await node_fetch_1.default(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': postData.length.toString()
                },
                body: postData
            });
            if (result.ok) {
                logger_1.default.info('Exchanging login code for token success');
                const json = await result.json();
                return this.getTokenFromResponse(json, scope);
            }
            else {
                logger_1.default.error('Exchanging login code for token failed');
                throw new Error('Unable to login.');
            }
        }
        catch (e) {
            logger_1.default.error(e.message);
            throw e;
        }
    }
    async refreshToken(refreshToken, scope, sessionId) {
        logger_1.default.info('Refreshing token...');
        const postData = querystring.stringify({
            refresh_token: refreshToken,
            client_id: clientId,
            grant_type: 'refresh_token',
            scope: scope
        });
        let result;
        try {
            result = await node_fetch_1.default(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': postData.length.toString()
                },
                body: postData
            });
        }
        catch (e) {
            logger_1.default.error('Refreshing token failed');
            throw new Error(exports.REFRESH_NETWORK_FAILURE);
        }
        try {
            if (result.ok) {
                const json = await result.json();
                const token = this.getTokenFromResponse(json, scope, sessionId);
                this.setToken(token, scope);
                logger_1.default.info('Token refresh success');
                return token;
            }
            else {
                throw new Error('Bad request.');
            }
        }
        catch (e) {
            vscode.window.showErrorMessage(localize('signOut', "You have been signed out because reading stored authentication information failed."));
            logger_1.default.error(`Refreshing token failed: ${result.statusText}`);
            throw new Error('Refreshing token failed');
        }
    }
    clearSessionTimeout(sessionId) {
        const timeout = this._refreshTimeouts.get(sessionId);
        if (timeout) {
            clearTimeout(timeout);
            this._refreshTimeouts.delete(sessionId);
        }
    }
    removeInMemorySessionData(sessionId) {
        const tokenIndex = this._tokens.findIndex(token => token.sessionId === sessionId);
        if (tokenIndex > -1) {
            this._tokens.splice(tokenIndex, 1);
        }
        this.clearSessionTimeout(sessionId);
    }
    pollForReconnect(sessionId, refreshToken, scope) {
        this.clearSessionTimeout(sessionId);
        this._refreshTimeouts.set(sessionId, setTimeout(async () => {
            try {
                await this.refreshToken(refreshToken, scope, sessionId);
            }
            catch (e) {
                this.pollForReconnect(sessionId, refreshToken, scope);
            }
        }, 1000 * 60 * 30));
    }
    handleRefreshNetworkError(sessionId, refreshToken, scope, attempts = 1) {
        return new Promise((resolve, _) => {
            if (attempts === 3) {
                logger_1.default.error('Token refresh failed after 3 attempts');
                return resolve(false);
            }
            if (attempts === 1) {
                const token = this._tokens.find(token => token.sessionId === sessionId);
                if (token) {
                    token.accessToken = undefined;
                    exports.onDidChangeSessions.fire({ added: [], removed: [], changed: [token.sessionId] });
                }
            }
            const delayBeforeRetry = 5 * attempts * attempts;
            this.clearSessionTimeout(sessionId);
            this._refreshTimeouts.set(sessionId, setTimeout(async () => {
                try {
                    await this.refreshToken(refreshToken, scope, sessionId);
                    return resolve(true);
                }
                catch (e) {
                    return resolve(await this.handleRefreshNetworkError(sessionId, refreshToken, scope, attempts + 1));
                }
            }, 1000 * delayBeforeRetry));
        });
    }
    async logout(sessionId) {
        logger_1.default.info(`Logging out of session '${sessionId}'`);
        this.removeInMemorySessionData(sessionId);
        if (this._tokens.length === 0) {
            await keychain_1.keychain.deleteToken();
        }
        else {
            this.storeTokenData();
        }
    }
    async clearSessions() {
        logger_1.default.info('Logging out of all sessions');
        this._tokens = [];
        await keychain_1.keychain.deleteToken();
        this._refreshTimeouts.forEach(timeout => {
            clearTimeout(timeout);
        });
        this._refreshTimeouts.clear();
    }
}
exports.AzureActiveDirectoryService = AzureActiveDirectoryService;
//# sourceMappingURL=AADHelper.js.map