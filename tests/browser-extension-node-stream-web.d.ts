import "node:stream/web";

// happy-dom 20.11 exposes this Node stream alias before @types/node 24 does.
// This test-only augmentation keeps strict library checking enabled.
declare module "node:stream/web" {
  type UnderlyingDefaultSource<R = any> = import("node:stream/web").UnderlyingSource<R>;
}
