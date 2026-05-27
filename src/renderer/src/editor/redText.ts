import { createReactStyleSpec } from '@blocknote/react';
import React from 'react';

export const RedText = createReactStyleSpec(
  { type: 'redText', propSchema: 'boolean' },
  {
    render: (props) =>
      React.createElement(
        'span',
        { style: { color: 'var(--red)' }, ref: props.contentRef },
        null
      ),
  }
);
