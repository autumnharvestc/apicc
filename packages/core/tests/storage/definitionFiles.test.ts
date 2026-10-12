import { describe, expect, it } from "vitest";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { listContractWorkspaceDefinitionFiles } from "../../src/storage/definitionFiles.js";

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  group: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000003",
  collection: "00000000-0000-4000-8000-000000000004",
  folder: "00000000-0000-4000-8000-000000000005",
  nestedFolder: "00000000-0000-4000-8000-000000000006",
  api: "00000000-0000-4000-8000-000000000007",
};

describe("listContractWorkspaceDefinitionFiles", () => {
  it("returns the encoder's canonical paths for deeply nested API definitions", () => {
    const workspace = ContractWorkspaceSchema.parse({
      formatVersion: 1,
      id: ids.workspace,
      name: "paths",
      groups: [{
        id: ids.group,
        name: "group",
        projects: [{
          id: ids.project,
          name: "project",
          globals: {},
          collections: [{
            id: ids.collection,
            name: "collection",
            folders: [{
              id: ids.folder,
              name: "parent",
              folders: [{
                id: ids.nestedFolder,
                name: "child",
                apis: [{
                  contract: {
                    formatVersion: 1,
                    id: ids.api,
                    metadata: { name: "API", description: "", tags: [], version: "1.0.0", status: "draft" },
                    request: {
                      protocol: "http", method: "GET", baseUrl: "", path: "/", pathParams: [], query: [],
                      headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" },
                    },
                    responses: [],
                  },
                  cases: [{ id: "case-id.1", name: "smoke", scope: "scope one", parameters: {}, assertions: [] }],
                  documentation: "# API",
                }],
              }],
            }],
          }],
        }],
      }],
    });

    const before = structuredClone(workspace);
    const files = listContractWorkspaceDefinitionFiles(workspace);

    expect(files).toEqual([
      "apicc.workspace.yaml",
      `groups/${ids.group}/group.yaml`,
      `groups/${ids.group}/projects/${ids.project}/project.yaml`,
      `groups/${ids.group}/projects/${ids.project}/collections/${ids.collection}/collection.yaml`,
      `groups/${ids.group}/projects/${ids.project}/collections/${ids.collection}/folders/${ids.folder}/folder.yaml`,
      `groups/${ids.group}/projects/${ids.project}/collections/${ids.collection}/folders/${ids.folder}/folders/${ids.nestedFolder}/folder.yaml`,
      `groups/${ids.group}/projects/${ids.project}/collections/${ids.collection}/folders/${ids.folder}/folders/${ids.nestedFolder}/apis/${ids.api}/api.yaml`,
      `groups/${ids.group}/projects/${ids.project}/collections/${ids.collection}/folders/${ids.folder}/folders/${ids.nestedFolder}/apis/${ids.api}/design.md`,
      `groups/${ids.group}/projects/${ids.project}/collections/${ids.collection}/folders/${ids.folder}/folders/${ids.nestedFolder}/apis/${ids.api}/cases/index.yaml`,
      `groups/${ids.group}/projects/${ids.project}/collections/${ids.collection}/folders/${ids.folder}/folders/${ids.nestedFolder}/apis/${ids.api}/cases/636173652d69642e31.73636f7065206f6e65.yaml`,
    ]);
    expect(workspace).toEqual(before);

    const second = listContractWorkspaceDefinitionFiles(workspace);
    expect(second).not.toBe(files);
    if (!Object.isFrozen(files)) (files as string[]).push("caller-only.yaml");
    expect(listContractWorkspaceDefinitionFiles(workspace)).toEqual(second);
  });

  it("rejects data the canonical workspace encoder cannot encode", () => {
    expect(() => listContractWorkspaceDefinitionFiles({ name: "not a workspace" } as never))
      .toThrow("Workspace contains invalid or unsupported contract data");
  });
});
