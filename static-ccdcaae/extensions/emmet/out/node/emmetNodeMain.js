"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = void 0;
const vscode = require("vscode");
const os_1 = require("os");
const emmetCommon_1 = require("../emmetCommon");
const util_1 = require("../util");
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('editor.emmet.action.updateImageSize', () => {
        return Promise.resolve().then(() => require('../updateImageSize')).then(uis => uis.updateImageSize());
    }));
    util_1.setHomeDir(vscode.Uri.file(os_1.homedir()));
    emmetCommon_1.activateEmmetExtension(context);
}
exports.activate = activate;
//# sourceMappingURL=emmetNodeMain.js.map