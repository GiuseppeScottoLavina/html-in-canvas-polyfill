// Ancestor moves (the canvas moved): see _ancestor-move.mjs. Split by group so that each file stays well inside the runner's file timeout.
import { MOVES, defineMoves } from './_ancestor-move.mjs';

defineMoves('ancestor move (canvas)', MOVES.canvas);
