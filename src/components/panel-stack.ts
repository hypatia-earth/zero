/**
 * PanelStack - Container for panel groups
 *
 * Flex column layout, respects UI margins
 */

import m from 'mithril';

interface Attrs {
  side: 'left' | 'right';
}

export const PanelStack: m.Component<Attrs> = {
  view(vnode) {
    return m(`.panel-stack.${vnode.attrs.side}`, vnode.children);
  },
};
