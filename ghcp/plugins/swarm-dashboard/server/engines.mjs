/**
 * The engine behind the launcher and the canvas. Until PR 1's engine/engine.mjs is on this branch it is the synthetic
 * demo engine; Task 20 switches it to Copilot's data by replacing the export below with:
 *   export { createSwarmEngine as createDefaultEngine } from '../engine/engine.mjs';
 */
export { createDemoEngine as createDefaultEngine } from './demo-engine.mjs';
