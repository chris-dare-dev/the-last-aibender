/**
 * CSS module-side-effect import shim for TS NodeNext resolution (the bundler
 * — vite — owns actual CSS handling). Mirrors the islands' shim.
 */
declare module '*.css';
