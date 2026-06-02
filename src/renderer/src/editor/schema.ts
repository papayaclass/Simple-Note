import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core';
import { RedText } from './redText';
import { Toggle } from './toggle';

export const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, toggle: Toggle() },
  inlineContentSpecs: defaultInlineContentSpecs,
  styleSpecs: { ...defaultStyleSpecs, redText: RedText },
});
