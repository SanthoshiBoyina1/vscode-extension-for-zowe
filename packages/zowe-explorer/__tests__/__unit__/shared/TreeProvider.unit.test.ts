/**
 * This program and the accompanying materials are made available under the terms of the
 * Eclipse Public License v2.0 which accompanies this distribution, and is available at
 * https://www.eclipse.org/legal/epl-v20.html
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Copyright Contributors to the Zowe Project.
 *
 */

import { createTreeView } from "../../../__mocks__/mockCreators/shared";
import { TreeProviders } from "../../../src/shared/TreeProviders";

describe("TreeProvider Unit Tests - Function getters", () => {
    it("should retrieve the ds provider", async () => {
        const mockTree = createTreeView("ds");
        await TreeProviders.initializeProviders({} as any, {
            ds: jest.fn(() => mockTree) as any,
            uss: jest.fn(),
            job: jest.fn(),
        });
        expect(TreeProviders.ds).toEqual(mockTree);
    });
    it("should retrieve the uss provider", async () => {
        const mockTree = createTreeView("uss");
        await TreeProviders.initializeProviders({} as any, {
            ds: jest.fn(),
            uss: jest.fn(() => mockTree) as any,
            job: jest.fn(),
        });
        expect(TreeProviders.uss).toEqual(mockTree);
    });
    it("should retrieve the uss provider", async () => {
        const mockTree = createTreeView("job");
        await TreeProviders.initializeProviders({} as any, {
            ds: jest.fn(),
            uss: jest.fn(),
            job: jest.fn(() => mockTree) as any,
        });
        expect(TreeProviders.job).toEqual(mockTree);
    });
});

describe("TreeProvider Unit Tests - Function sessionIsPresentInOtherTrees", () => {
    it("should return true if session is present in another tree", async () => {
        await TreeProviders.initializeProviders({} as any, {
            ds: () => ({ mSessionNodes: [{ getLabel: () => "test1" }, { getLabel: () => "test2" }] } as any),
            uss: () => ({ mSessionNodes: [{ getLabel: () => "test3" }, { getLabel: () => "test4" }] } as any),
            job: () => ({ mSessionNodes: [{ getLabel: () => "test5" }, { getLabel: () => "test1" }] } as any),
        });
        expect(TreeProviders.sessionIsPresentInOtherTrees("test1")).toEqual(true);
    });
});
