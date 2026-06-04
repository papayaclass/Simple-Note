import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core';
import { RedText } from './redText';
import { Toggle } from './toggle';
import { Divider } from './divider';

export const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, toggle: Toggle(), divider: Divider() },
  inlineContentSpecs: defaultInlineContentSpecs,
  styleSpecs: { ...defaultStyleSpecs, redText: RedText },
});
