#!/usr/bin/env ts-node
"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
// Inlines "allOf"s to allow for "additionalProperties": false. (https://github.com/microsoft/vscode-remote-release/issues/2967)
// Run this manually after updating devContainer.schema.src.json.
const fs = require("fs");
function transform(schema) {
    const definitions = Object.keys(schema.definitions)
        .reduce((d, k) => {
        d[`#/definitions/${k}`] = schema.definitions[k];
        return d;
    }, {});
    function copy(from) {
        const type = Array.isArray(from) ? 'array' : typeof from;
        switch (type) {
            case 'object': {
                const to = {};
                for (const key in from) {
                    switch (key) {
                        case 'definitions':
                            break;
                        case 'oneOf':
                            const list = copy(from[key])
                                .reduce((a, o) => {
                                if (o.oneOf) {
                                    a.push(...o.oneOf);
                                }
                                else {
                                    a.push(o);
                                }
                                return a;
                            }, []);
                            if (list.length === 1) {
                                Object.assign(to, list[0]);
                            }
                            else {
                                to.oneOf = list;
                            }
                            break;
                        case 'allOf':
                            const all = copy(from[key]);
                            const leaves = all.map((one) => (one.oneOf ? one.oneOf : [one]));
                            function cross(res, leaves) {
                                if (leaves.length) {
                                    const rest = leaves.slice(1);
                                    return [].concat(...leaves[0].map(leaf => {
                                        const intermediate = { ...res, ...leaf };
                                        if ('properties' in res && 'properties' in leaf) {
                                            intermediate.properties = {
                                                ...res.properties,
                                                ...leaf.properties,
                                            };
                                        }
                                        return cross(intermediate, rest);
                                    }));
                                }
                                return [res];
                            }
                            const list2 = cross({}, leaves);
                            if (list2.length === 1) {
                                Object.assign(to, list2[0]);
                            }
                            else {
                                to.oneOf = list2;
                            }
                            break;
                        case '$ref':
                            const ref = from[key];
                            const definition = definitions[ref];
                            if (definition) {
                                Object.assign(to, copy(definition));
                            }
                            else {
                                to[key] = ref;
                            }
                            break;
                        default:
                            to[key] = copy(from[key]);
                            break;
                    }
                }
                if (to.type === 'object' && !('additionalProperties' in to)) {
                    to.additionalProperties = false;
                }
                return to;
            }
            case 'array': {
                return from.map(copy);
            }
            default:
                return from;
        }
    }
    return copy(schema);
}
const devContainer = JSON.parse(fs.readFileSync('../schemas/devContainer.schema.src.json', 'utf8'));
fs.writeFileSync('../schemas/devContainer.schema.generated.json', JSON.stringify(transform(devContainer), undefined, '	'));
//# sourceMappingURL=inline-allOf.js.map