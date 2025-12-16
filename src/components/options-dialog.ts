/**
 * Options Dialog Component
 *
 * Auto-generated UI from schema metadata.
 * - Modal centered on desktop, slide-up on mobile
 * - Draggable header (desktop only)
 * - Filter support for layer-specific views
 */

import m from 'mithril';
import {
  getOptionsGrouped,
  getOptionsFiltered,
  optionGroups,
  defaultOptions,
  type ZeroOptions,
  type FlatOption,
} from '../schemas/options.schema';
import type { OptionsService } from '../services/options-service';
import type { PaletteService } from '../services/palette-service';
import { clearCache } from '../services/sw-registration';
import { RadioPaletteControl } from './radio-palette-control';

// ============================================================
// Type guards for control types
// ============================================================

interface SliderMeta {
  control: 'slider';
  min: number;
  max: number;
  step: number;
}

interface SelectMeta {
  control: 'select';
  options: { value: string | number; label: string }[];
}

interface RadioMeta {
  control: 'radio';
  options: { value: string | number; label: string }[];
}

// ============================================================
// Drag state (persists across redraws)
// ============================================================

let dragState = {
  isDragging: false,
  startX: 0,
  startY: 0,
  offsetX: 0,
  offsetY: 0,
};

function resetDragState(): void {
  dragState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
}

// Module-level state for advanced toggle
let showAdvanced = false;

// ============================================================
// Helpers
// ============================================================

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function setOptionValue(optionsService: OptionsService, path: string, value: unknown): void {
  optionsService.update((draft) => {
    const keys = path.split('.');
    let current: unknown = draft;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (key === undefined) return;
      current = (current as Record<string, unknown>)[key];
    }
    const lastKey = keys[keys.length - 1];
    if (lastKey === undefined) return;
    (current as Record<string, unknown>)[lastKey] = value;
  });
}

function isModified(path: string, currentValue: unknown): boolean {
  const defaultValue = getByPath(defaultOptions, path);
  return currentValue !== defaultValue;
}

function formatValue(value: number, meta: SliderMeta): string {
  if (meta.max === 1 && meta.min <= 0.1) {
    return `${Math.round(value * 100)}%`;
  }
  if (meta.step < 0.1) return value.toFixed(2);
  if (meta.step < 1) return value.toFixed(1);
  return String(value);
}

// ============================================================
// Control renderers
// ============================================================

function renderControl(opt: FlatOption, currentValue: unknown, optionsService: OptionsService, paletteService: PaletteService): m.Children {
  const { path, meta } = opt;

  // Special handling for palette selection
  if (path.endsWith('.palette')) {
    const layerId = path.split('.')[0];
    const palettes = paletteService.getPalettes(layerId ?? 'temp');

    return m(RadioPaletteControl, {
      palettes,
      selected: currentValue as string,
      onSelect: (paletteName: string) => {
        setOptionValue(optionsService, path, paletteName);
        paletteService.setPalette(layerId ?? 'temp', paletteName);
      }
    });
  }

  switch (meta.control) {
    case 'toggle':
      return m('label.toggle', [
        m('input[type=checkbox]', {
          checked: currentValue as boolean,
          onchange: (e: Event) => {
            setOptionValue(optionsService, path, (e.target as HTMLInputElement).checked);
          }
        }),
        m('span.track')
      ]);

    case 'slider': {
      const sliderMeta = meta as SliderMeta;
      return m('div.slider', [
        m('input[type=range]', {
          min: sliderMeta.min,
          max: sliderMeta.max,
          step: sliderMeta.step,
          value: currentValue as number,
          oninput: (e: Event) => {
            setOptionValue(optionsService, path, parseFloat((e.target as HTMLInputElement).value));
          }
        }),
        m('span.value', formatValue(currentValue as number, sliderMeta))
      ]);
    }

    case 'select': {
      const selectMeta = meta as SelectMeta;
      return m('select.select', {
        value: currentValue,
        onchange: (e: Event) => {
          setOptionValue(optionsService, path, (e.target as HTMLSelectElement).value);
        }
      }, selectMeta.options.map(o =>
        m('option', { value: o.value }, o.label)
      ));
    }

    case 'radio': {
      const radioMeta = meta as RadioMeta;
      const layerId = path.split('.')[0];
      const isLoading = optionsService.loadingLayers.value.has(layerId ?? '');

      return m('div.radio-group', [
        m('span.spinner', { class: isLoading ? 'visible' : '' }),
        ...radioMeta.options.map(o =>
          m('label.radio', {
            class: currentValue === o.value ? 'selected' : ''
          }, [
            m('input[type=radio]', {
              name: path,
              value: o.value,
              checked: currentValue === o.value,
              onchange: () => setOptionValue(optionsService, path, o.value)
            }),
            m('span', o.label)
          ])
        )
      ]);
    }
  }
}

function renderOption(opt: FlatOption, options: ZeroOptions, optionsService: OptionsService, paletteService: PaletteService): m.Children {
  const currentValue = getByPath(options, opt.path);
  const modified = isModified(opt.path, currentValue);
  const isPalette = opt.path.endsWith('.palette');

  return m('div.row', { key: opt.path, class: isPalette ? 'palette-row' : '' }, [
    m('div.info', isPalette ? [
      m('div.text', [
        m('label.label', opt.meta.label),
        opt.meta.description ? m('span.hint', opt.meta.description) : null
      ]),
      m('button.reset', {
        title: 'Reset to default',
        onclick: () => optionsService.reset(opt.path),
        style: { visibility: modified ? 'visible' : 'hidden' }
      }, '↺')
    ] : [
      m('label.label', opt.meta.label),
      opt.meta.description ? m('span.hint', opt.meta.description) : null
    ].filter(Boolean)),
    m('div.controls', [
      !isPalette ? m('button.reset', {
        title: 'Reset to default',
        onclick: () => optionsService.reset(opt.path),
        style: { visibility: modified ? 'visible' : 'hidden' }
      }, '↺') : null,
      renderControl(opt, currentValue, optionsService, paletteService)
    ].filter(Boolean))
  ]);
}

// ============================================================
// Layer labels
// ============================================================

const layerLabels: Record<string, string> = {
  earth: 'Earth',
  sun: 'Sun',
  grid: 'Grid',
  temp: 'Temperature',
  rain: 'Precipitation',
  clouds: 'Cloud Cover',
  humidity: 'Humidity',
  wind: 'Wind',
  pressure: 'Pressure',
};

const advancedSubgroups: Record<string, string> = {
  'viewport.mouse': 'Mouse',
  'viewport.touch': 'Touch',
  'debug': 'Development',
};

function getAdvancedSubgroup(path: string): string {
  for (const prefix of Object.keys(advancedSubgroups)) {
    if (path.startsWith(prefix + '.') || path.startsWith(prefix)) {
      return prefix;
    }
  }
  return 'other';
}

// ============================================================
// Group renderer
// ============================================================

function renderGroup(
  groupId: string,
  groupOptions: FlatOption[],
  options: ZeroOptions,
  optionsService: OptionsService,
  paletteService: PaletteService,
  showAdvancedOptions: boolean,
  skipGroupHeader: boolean = false
): m.Children {
  const group = optionGroups[groupId as keyof typeof optionGroups];
  if (!group) return null;

  const currentModel = options.viewport.physicsModel;

  // Filter options
  const visibleOptions = groupOptions.filter(o => {
    if (!showAdvancedOptions && o.meta.group === 'advanced') return false;
    if (o.meta.model && o.meta.model !== currentModel) return false;
    return true;
  });

  if (visibleOptions.length === 0) return null;

  // Layers group: sub-group by layer ID
  if (groupId === 'layers' && !skipGroupHeader) {
    const byLayer = new Map<string, FlatOption[]>();
    for (const opt of visibleOptions) {
      const layerId = opt.path.split('.')[0] ?? 'other';
      if (!byLayer.has(layerId)) byLayer.set(layerId, []);
      byLayer.get(layerId)!.push(opt);
    }

    return m('div.section', { key: groupId }, [
      m('h3.title', { key: '_title' }, group.label),
      group.description ? m('p.description', { key: '_desc' }, group.description) : null,
      ...Array.from(byLayer.entries()).map(([layerId, opts]) =>
        m('div.subsection', { key: layerId }, [
          m('h4.title', { key: `${layerId}_title` }, layerLabels[layerId] || layerId),
          ...opts.map(opt => renderOption(opt, options, optionsService, paletteService))
        ])
      )
    ].filter(Boolean));
  }

  // Advanced group: sub-group by path prefix
  if (groupId === 'advanced') {
    const bySubgroup = new Map<string, FlatOption[]>();
    for (const opt of visibleOptions) {
      const subgroup = getAdvancedSubgroup(opt.path);
      if (!bySubgroup.has(subgroup)) bySubgroup.set(subgroup, []);
      bySubgroup.get(subgroup)!.push(opt);
    }

    const subgroupOrder = ['viewport.mouse', 'viewport.touch', 'debug', 'other'];
    const sortedSubgroups = Array.from(bySubgroup.entries()).sort((a, b) => {
      return subgroupOrder.indexOf(a[0]) - subgroupOrder.indexOf(b[0]);
    });

    return m('div.section', { key: groupId }, [
      m('h3.title', { key: '_title' }, group.label),
      group.description ? m('p.description', { key: '_desc' }, group.description) : null,
      ...sortedSubgroups.map(([subgroupKey, opts]) =>
        m('div.subsection', { key: subgroupKey }, [
          m('h4.title', { key: `${subgroupKey}_title` }, advancedSubgroups[subgroupKey] || subgroupKey),
          ...opts.map(opt => renderOption(opt, options, optionsService, paletteService))
        ])
      )
    ].filter(Boolean));
  }

  return m('div.section', { key: groupId }, [
    !skipGroupHeader ? m('h3.title', { key: '_title' }, group.label) : null,
    !skipGroupHeader && group.description ? m('p.description', { key: '_desc' }, group.description) : null,
    ...visibleOptions.map(opt => renderOption(opt, options, optionsService, paletteService))
  ].filter(Boolean));
}

// ============================================================
// Component
// ============================================================

export interface OptionsDialogAttrs {
  optionsService: OptionsService;
  paletteService: PaletteService;
}

export const OptionsDialog: m.ClosureComponent<OptionsDialogAttrs> = () => {
  return {
    view({ attrs }) {
      const { optionsService, paletteService } = attrs;

    if (!optionsService.dialogOpen) return null;

    const filter = optionsService.dialogFilter;
    const options = optionsService.options.value;

    // Get options based on filter
    let filteredGroups: Record<string, FlatOption[]>;

    if (filter && filter !== 'global') {
      // Filter mode: show only options matching the filter
      const filtered = getOptionsFiltered(filter);
      filteredGroups = {};
      for (const opt of filtered) {
        const group = opt.meta.group;
        if (!filteredGroups[group]) filteredGroups[group] = [];
        filteredGroups[group].push(opt);
      }
    } else {
      // Global mode: show all options (respecting filter includes 'global')
      const allOptions = getOptionsFiltered('global');
      filteredGroups = {};
      for (const opt of allOptions) {
        const group = opt.meta.group;
        if (!filteredGroups[group]) filteredGroups[group] = [];
        filteredGroups[group].push(opt);
      }
    }

    // Sort groups by order (exclude 'advanced')
    const sortedGroupIds = Object.keys(filteredGroups)
      .filter(id => id !== 'advanced')
      .sort((a, b) => {
        const orderA = optionGroups[a as keyof typeof optionGroups]?.order ?? 99;
        const orderB = optionGroups[b as keyof typeof optionGroups]?.order ?? 99;
        return orderA - orderB;
      });

    // Check for advanced options
    const grouped = getOptionsGrouped();
    const advancedGroup = grouped['advanced'];
    const hasAdvanced = !filter && advancedGroup !== undefined && advancedGroup.length > 0;

    // Dialog title
    const filterTitles: Record<string, string> = {
      dataCache: 'Download',
      gpu: 'GPU',
    };
    const dialogTitle = filter && filter !== 'global'
      ? `${filterTitles[filter] ?? layerLabels[filter] ?? filter} Options`
      : 'Options';

    const isDesktop = window.innerWidth > 600;

    // Drag handlers
    const onMouseDown = (e: MouseEvent) => {
      if (!isDesktop) return;
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      dragState.isDragging = true;
      dragState.startX = e.clientX - dragState.offsetX;
      dragState.startY = e.clientY - dragState.offsetY;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragState.isDragging) return;
      dragState.offsetX = e.clientX - dragState.startX;
      dragState.offsetY = e.clientY - dragState.startY;
      m.redraw();
    };

    const onMouseUp = () => {
      dragState.isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    const dialogStyle = (dragState.offsetX !== 0 || dragState.offsetY !== 0)
      ? { transform: `translate(${dragState.offsetX}px, ${dragState.offsetY}px)` }
      : {};

    return m('div.dialog.options', [
      m('div.backdrop', {
        onclick: () => {
          resetDragState();
          optionsService.closeDialog();
        }
      }),
      m('div.window', {
        class: dragState.isDragging ? 'dragging' : '',
        style: dialogStyle
      }, [
        m('div.header', { onmousedown: onMouseDown }, [
          m('h2', dialogTitle),
          m('button.close', {
            onclick: () => {
              resetDragState();
              optionsService.closeDialog();
            }
          }, '×')
        ]),
        m('div.content', [
          ...sortedGroupIds.map(groupId => {
            const groupOpts = filteredGroups[groupId];
            if (!groupOpts) return null;
            return renderGroup(groupId, groupOpts, options, optionsService, paletteService, showAdvanced, !!filter && filter !== 'global');
          }).filter(Boolean),

          // Danger zone (only in global view, above advanced toggle)
          !filter || filter === 'global' ? m('div.danger-zone', { key: '_danger_zone' }, [
            m('h3', 'Danger Zone'),
            m('div.actions', [
              m('button.btn-danger', {
                onclick: () => optionsService.reset()
              }, 'Reset All'),
              m('button.btn-danger', {
                onclick: async () => {
                  await clearCache();
                  location.reload();
                }
              }, 'Clear Cache'),
            ])
          ]) : null,

          // Advanced toggle (only in full dialog)
          hasAdvanced ? m('div.advanced-toggle', {
            key: '_advanced_toggle',
            onclick: () => {
              showAdvanced = !showAdvanced;
              m.redraw();
            }
          }, [
            m('label', [
              m('input[type=checkbox]', {
                checked: showAdvanced,
                onclick: (e: Event) => e.stopPropagation()
              }),
              'Show advanced options'
            ])
          ]) : null,

          // Advanced group
          showAdvanced && advancedGroup
            ? renderGroup('advanced', advancedGroup, options, optionsService, paletteService, true)
            : null
        ].filter(Boolean)),
        m('div.footer', [
          m('div.actions', [
            filter && filter !== 'global' ? m('button.btn-reset', {
              onclick: () => optionsService.reset(filter)
            }, 'Reset Layer') : null,
            m('button.btn-close', {
              onclick: () => {
                resetDragState();
                optionsService.closeDialog();
              }
            }, 'Close')
          ])
        ])
      ])
    ]);
    }
  };
};
