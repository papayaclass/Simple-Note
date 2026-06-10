import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from '@blocknote/core';
import { RedText } from './redText';
import { Toggle } from './toggle';
import { Divider } from './divider';
import { ImageBlock } from './image';

export const schema = BlockNoteSchema.create({
  // `image` overrides BlockNote's built-in image block (which needs an upload
  // handler / file panel) with our in-memory, paste/drop-driven one.
  blockSpecs: { ...defaultBlockSpecs, image: ImageBlock(), toggle: Toggle(), divider: Divider() },
  inlineContentSpecs: defaultInlineContentSpecs,
  styleSpecs: { ...defaultStyleSpecs, redText: RedText },
});
