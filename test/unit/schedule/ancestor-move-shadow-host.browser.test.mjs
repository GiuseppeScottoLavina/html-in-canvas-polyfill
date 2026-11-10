// Ancestor moves (the shadow host of the canvas moved in the document): see _ancestor-move.mjs. Split by group so that each file stays well inside the runner's file timeout.
import { MOVES, defineMoves } from './_ancestor-move.mjs';

defineMoves('ancestor move (shadow-host)', MOVES.host, { shadow: true });
