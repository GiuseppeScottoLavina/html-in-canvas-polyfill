// Ancestor moves (an ancestor of the canvas moved, or the canvas there and back): see _ancestor-move.mjs. Split by group so that each file stays well inside the runner's file timeout.
import { MOVES, defineMoves } from './_ancestor-move.mjs';

defineMoves('ancestor move (ancestor)', MOVES.ancestor);
