/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha256 = void 0;
async function sha256(s) {
    return (require('crypto')).createHash('sha256').update(s).digest('base64');
}
exports.sha256 = sha256;
//# sourceMappingURL=sha256.js.map