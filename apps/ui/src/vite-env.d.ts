/** Vite worker-URL import: resolves to the URL of the bundled worker chunk. */
declare module "*?worker&url" {
  const url: string
  export default url
}
