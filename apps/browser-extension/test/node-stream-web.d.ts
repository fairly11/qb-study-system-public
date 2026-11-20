import "node:stream/web";

declare module "node:stream/web" {
  type UnderlyingDefaultSource<R = any> = import("node:stream/web").UnderlyingSource<R>;
}
