// Ancestor moves under a parent that already sets an inherited value, in the document and in a shadow tree: see _ancestor-move.mjs.
import { definePresetMoves } from './_ancestor-move.mjs';

definePresetMoves('ancestor move (preset)');
definePresetMoves('ancestor move (preset, shadow)', { shadow: true });
