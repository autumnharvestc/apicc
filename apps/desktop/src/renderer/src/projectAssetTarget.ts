export type ProjectAssetTarget =
  | { kind: "model"; id: string }
  | { kind: "auth"; id: string };
