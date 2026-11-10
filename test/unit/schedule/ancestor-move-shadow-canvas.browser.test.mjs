// Ancestor moves (in a shadow tree, the canvas moved): see _ancestor-move.mjs. Split by group so that each file stays well inside the runner's file timeout.
import { MOVES, defineMoves } from './_ancestor-move.mjs';

defineMoves('ancestor move (shadow-canvas)', MOVES.canvas, { shadow: true });
