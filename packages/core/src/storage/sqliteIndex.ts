import Database from "better-sqlite3";
import { collectProjectAssetReferences, type AssetReference } from "../assets/graph.js";
import type { ApiAsset } from "../contract/model.js";
import type { ContractCollection, ContractFolder, ContractProject, ContractWorkspace } from "../contract/workspace.js";
import {
  apiCaseFilePath,
  apiDirectoryPath,
  collectionDirectoryPath,
  componentAssetFilePath,
  folderDirectoryPath,
  groupDirectoryPath,
  modelAssetFilePath,
  projectDirectoryPath,
  projectMetadataFilePath,
  type ApiFileLocation,
  type CollectionFileLocation,
} from "./paths.js";

export interface IndexedObject {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  path: string;
  groupId: string | null;
  projectId: string | null;
  ownerId: string;
  scope?: string;
  /** Logical member locator inside the inline project.yaml document; this is not a second file path. */
  locator?: string;
}

export interface IndexedObjectIdentity {
  type: string;
  groupId: string | null;
  projectId: string | null;
  ownerId: string;
  id: string;
  scope?: string;
}

export interface IndexedAssetReference extends AssetReference {
  groupId: string;
  projectId: string;
}

interface StoredObject {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  path: string;
  groupId: string;
  projectId: string;
  ownerId: string;
  scope: string;
  locator: string | null;
}

const INDEX_SCHEMA_VERSION = 3;

function publicObject(row: StoredObject): IndexedObject {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    parentId: row.parentId,
    path: row.path,
    groupId: row.groupId === "" ? null : row.groupId,
    projectId: row.projectId === "" ? null : row.projectId,
    ownerId: row.ownerId,
    ...(row.scope === "" ? {} : { scope: row.scope }),
    ...(row.locator === null ? {} : { locator: row.locator }),
  };
}

function collectProjectApis(project: ContractProject): ApiAsset[] {
  const apis: ApiAsset[] = [];
  const visitFolder = (folder: ContractFolder): void => {
    apis.push(...folder.apis);
    for (const child of folder.folders) visitFolder(child);
  };
  for (const collection of project.collections) {
    apis.push(...collection.apis);
    for (const folder of collection.folders) visitFolder(folder);
  }
  return apis;
}

function addApiObjects(
  rows: IndexedObject[],
  location: CollectionFileLocation,
  folderIds: readonly string[],
  parentId: string,
  api: ApiAsset,
): void {
  const apiId = api.contract.id;
  const apiLocation: ApiFileLocation = { ...location, folderIds, apiId };
  rows.push({
    id: apiId,
    type: "api",
    name: api.contract.metadata.name,
    parentId,
    path: apiDirectoryPath(apiLocation),
    groupId: location.groupId,
    projectId: location.projectId,
    ownerId: parentId,
  });
  for (const testCase of api.cases) {
    rows.push({
      id: testCase.id,
      type: "case",
      name: testCase.name,
      parentId: apiId,
      groupId: location.groupId,
      projectId: location.projectId,
      ownerId: apiId,
      scope: testCase.scope,
      path: apiCaseFilePath(apiLocation, testCase.id, testCase.scope),
    });
  }
}

export class SqliteIndex {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    const schemaVersion = Number(this.db.pragma("user_version", { simple: true }));
    if (schemaVersion !== INDEX_SCHEMA_VERSION) {
      // This database is only a derived cache. Discard obsolete rows instead of migrating them as facts.
      this.db.exec("DROP TABLE IF EXISTS objects; DROP TABLE IF EXISTS asset_references;");
      this.createSchema();
      this.db.pragma(`user_version = ${INDEX_SCHEMA_VERSION}`);
    } else {
      this.createSchema();
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        type TEXT NOT NULL,
        groupId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        ownerId TEXT NOT NULL,
        id TEXT NOT NULL,
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        parentId TEXT,
        path TEXT NOT NULL,
        locator TEXT,
        PRIMARY KEY (type, groupId, projectId, ownerId, id, scope)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS objects_by_id ON objects (id, type, groupId, projectId, ownerId, scope, path);
      CREATE INDEX IF NOT EXISTS objects_by_type ON objects (type, path, groupId, projectId, ownerId, id, scope);
      CREATE TABLE IF NOT EXISTS asset_references (
        groupId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        ownerId TEXT NOT NULL,
        path TEXT NOT NULL,
        targetId TEXT NOT NULL,
        expectedKind TEXT NOT NULL,
        PRIMARY KEY (groupId, projectId, ownerId, path, targetId, expectedKind)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS references_by_target ON asset_references (groupId, projectId, targetId, expectedKind, ownerId, path);
      CREATE INDEX IF NOT EXISTS references_by_owner ON asset_references (groupId, projectId, ownerId, path, targetId, expectedKind);
    `);
  }

  rebuild(workspace: ContractWorkspace): void {
    const insertObject = this.db.prepare(`
      INSERT INTO objects (type, groupId, projectId, ownerId, id, scope, name, parentId, path, locator)
      VALUES (@type, @groupId, @projectId, @ownerId, @id, @scope, @name, @parentId, @path, @locator)
    `);
    const insertReference = this.db.prepare(`
      INSERT INTO asset_references (groupId, projectId, ownerId, path, targetId, expectedKind)
      VALUES (@groupId, @projectId, @ownerId, @path, @targetId, @expectedKind)
    `);
    const rows: IndexedObject[] = [{
      id: workspace.id,
      type: "workspace",
      name: workspace.name,
      parentId: null,
      ownerId: workspace.id,
      path: ".",
      groupId: null,
      projectId: null,
    }];
    const references: IndexedAssetReference[] = [];

    for (const group of workspace.groups) {
      rows.push({
        id: group.id,
        type: "group",
        name: group.name,
        parentId: workspace.id,
        ownerId: workspace.id,
        path: groupDirectoryPath(group.id),
        groupId: group.id,
        projectId: null,
      });
      for (const project of group.projects) {
        const projectPath = projectDirectoryPath(group.id, project.id);
        const projectMetadataPath = projectMetadataFilePath(group.id, project.id);
        rows.push({
          id: project.id,
          type: "project",
          name: project.name,
          parentId: group.id,
          ownerId: group.id,
          path: projectPath,
          groupId: group.id,
          projectId: project.id,
        });
        for (const environment of project.environments) {
          rows.push({
            id: environment.id,
            type: "environment",
            name: environment.name,
            parentId: project.id,
            ownerId: project.id,
            path: projectMetadataPath,
            groupId: group.id,
            projectId: project.id,
            locator: `environments/${environment.id}`,
          });
        }
        for (const workflow of project.workflows) {
          rows.push({
            id: workflow.id,
            type: "workflow",
            name: workflow.name,
            parentId: project.id,
            ownerId: project.id,
            path: projectMetadataPath,
            groupId: group.id,
            projectId: project.id,
            locator: `workflows/${workflow.id}`,
          });
        }
        for (const collection of project.collections) {
          const location: CollectionFileLocation = { groupId: group.id, projectId: project.id, collectionId: collection.id };
          rows.push({
            id: collection.id,
            type: "collection",
            name: collection.name,
            parentId: project.id,
            ownerId: project.id,
            path: collectionDirectoryPath(location),
            groupId: group.id,
            projectId: project.id,
          });
          for (const api of collection.apis) addApiObjects(rows, location, [], collection.id, api);

          const visitFolder = (folder: ContractFolder, folderIds: readonly string[], parentId: string): void => {
            const childIds = [...folderIds, folder.id];
            rows.push({
              id: folder.id,
              type: "folder",
              name: folder.name,
              parentId,
              ownerId: parentId,
              path: folderDirectoryPath(location, childIds),
              groupId: group.id,
              projectId: project.id,
            });
            for (const api of folder.apis) addApiObjects(rows, location, childIds, folder.id, api);
            for (const child of folder.folders) visitFolder(child, childIds, folder.id);
          };
          for (const folder of collection.folders) visitFolder(folder, [], collection.id);
        }
        for (const model of project.models) {
          rows.push({
            id: model.id,
            type: "model",
            name: model.name,
            parentId: project.id,
            ownerId: project.id,
            path: modelAssetFilePath({ groupId: group.id, projectId: project.id }, model.id),
            groupId: group.id,
            projectId: project.id,
          });
        }
        for (const component of project.components) {
          rows.push({
            id: component.id,
            type: component.kind,
            name: component.name,
            parentId: project.id,
            ownerId: project.id,
            path: componentAssetFilePath({ groupId: group.id, projectId: project.id }, component.kind, component.id),
            groupId: group.id,
            projectId: project.id,
          });
        }
        const projectReferences = collectProjectAssetReferences({
          assets: collectProjectApis(project),
          models: project.models,
          components: project.components,
        });
        references.push(...projectReferences.map((reference) => ({ groupId: group.id, projectId: project.id, ...reference })));
      }
    }

    this.db.transaction(() => {
      this.db.exec("DELETE FROM objects; DELETE FROM asset_references;");
      for (const row of rows) {
        insertObject.run({
          ...row,
          groupId: row.groupId ?? "",
          projectId: row.projectId ?? "",
          scope: row.scope ?? "",
          locator: row.locator ?? null,
        });
      }
      for (const reference of references) insertReference.run(reference);
    })();
  }

  byId(id: string): IndexedObject | undefined {
    const row = this.db.prepare(`
      SELECT id, type, name, parentId, path, groupId, projectId, ownerId, scope, locator
      FROM objects WHERE id = ?
      ORDER BY type COLLATE BINARY, groupId COLLATE BINARY, projectId COLLATE BINARY,
        ownerId COLLATE BINARY, scope COLLATE BINARY, path COLLATE BINARY
      LIMIT 1
    `).get(id) as StoredObject | undefined;
    return row ? publicObject(row) : undefined;
  }

  byIdentity(identity: IndexedObjectIdentity): IndexedObject | undefined {
    const row = this.db.prepare(`
      SELECT id, type, name, parentId, path, groupId, projectId, ownerId, scope, locator
      FROM objects
      WHERE type = ? AND groupId = ? AND projectId = ? AND ownerId = ? AND id = ? AND scope = ?
    `).get(
      identity.type,
      identity.groupId ?? "",
      identity.projectId ?? "",
      identity.ownerId,
      identity.id,
      identity.scope ?? "",
    ) as StoredObject | undefined;
    return row ? publicObject(row) : undefined;
  }

  byType(type: string): IndexedObject[] {
    const rows = this.db.prepare(`
      SELECT id, type, name, parentId, path, groupId, projectId, ownerId, scope, locator
      FROM objects WHERE type = ?
      ORDER BY path COLLATE BINARY, groupId COLLATE BINARY, projectId COLLATE BINARY,
        ownerId COLLATE BINARY, id COLLATE BINARY, scope COLLATE BINARY
    `).all(type) as StoredObject[];
    return rows.map(publicObject);
  }

  referencesFrom(groupId: string, projectId: string, ownerId: string): IndexedAssetReference[] {
    return this.db.prepare(`
      SELECT groupId, projectId, ownerId, path, targetId, expectedKind
      FROM asset_references WHERE groupId = ? AND projectId = ? AND ownerId = ?
      ORDER BY path COLLATE BINARY, ownerId COLLATE BINARY, targetId COLLATE BINARY, expectedKind COLLATE BINARY
    `).all(groupId, projectId, ownerId) as IndexedAssetReference[];
  }

  referencesTo(groupId: string, projectId: string, targetId: string, expectedKind?: string): IndexedAssetReference[] {
    const rows = expectedKind === undefined
      ? this.db.prepare(`
          SELECT groupId, projectId, ownerId, path, targetId, expectedKind
          FROM asset_references WHERE groupId = ? AND projectId = ? AND targetId = ?
          ORDER BY ownerId COLLATE BINARY, path COLLATE BINARY, expectedKind COLLATE BINARY
        `).all(groupId, projectId, targetId)
      : this.db.prepare(`
          SELECT groupId, projectId, ownerId, path, targetId, expectedKind
          FROM asset_references WHERE groupId = ? AND projectId = ? AND targetId = ? AND expectedKind = ?
          ORDER BY ownerId COLLATE BINARY, path COLLATE BINARY, expectedKind COLLATE BINARY
        `).all(groupId, projectId, targetId, expectedKind);
    return rows as IndexedAssetReference[];
  }

  close(): void {
    this.db.close();
  }
}
