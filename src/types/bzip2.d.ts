declare module "bzip2" {
  export function decompress(data: Uint8Array | Buffer): Uint8Array;
  export function array(data: Uint8Array): any;
  export function simple(bitstream: any): Uint8Array;
  export function header(data: Uint8Array): any;
}
