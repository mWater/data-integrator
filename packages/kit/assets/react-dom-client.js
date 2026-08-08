import { ReactDOMClient as m } from "./react-core.js";
export const createRoot = m.createRoot;
export const hydrateRoot = m.hydrateRoot;
export const version = m.version;
export default m.default ?? m;
