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
  type PressureColorOption,
} from '../schemas/options.schema';
import type { OptionsService } from '../services/options-service';
import type { PaletteService } from '../services/palette-service';
import { getByPath } from '../utils/object';
import type { ConfigService } from '../services/config-service';
import type { DialogService } from '../services/dialog-service';
import type { CapabilitiesService } from '../services/capabilities-service';
import { clearCache, nuke } from '../services/sw-registration';
import { RadioPaletteControl } from './radio-palette-control';
import { PressureColorControl } from './pressure-color-control';

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
  options: { value: string | number; label: string; localhostOnly?: boolean; maxCores?: number }[];
}

interface RadioMeta {
  control: 'radio';
  options: { value: string | number; label: string; localhostOnly?: boolean }[];
}

interface LayerToggleMeta {
  control: 'layer-toggle';
  layerId: string;
}

const isLocalhost = location.hostname === 'localhost';

// ============================================================
// Prefetch size calculation
// ============================================================

/** Timesteps per forecast day range (ECMWF: 1h to 90h, 3h to 144h, 6h after) */
const TIMESTEPS_BY_DAYS: Record<string, number> = {
  '1': 24,   // 0-24h: hourly
  '2': 48,   // 0-48h: hourly
  '4': 92,   // 0-72h hourly (72) + 72-96h mixed (20)
  '6': 108,  // + 96-144h 3-hourly (16)
  '8': 116,  // + 144-192h 6-hourly (8)
};

/** Network transfer size per timestep per layer (MB) from defaultSizeEstimate */
const SIZE_PER_TIMESTEP_MB: Record<string, number> = {
  temp: 8,
  pressure: 2,
  wind: 16.4,  // U + V components
};

/** Calculate estimated prefetch size in MB */
function calculatePrefetchSizeMB(days: string, layers: { temp: boolean; pressure: boolean; wind: boolean }): number {
  const timesteps = TIMESTEPS_BY_DAYS[days] ?? 48;
  let sizePerTimestep = 0;
  if (layers.temp) sizePerTimestep += SIZE_PER_TIMESTEP_MB.temp ?? 0;
  if (layers.pressure) sizePerTimestep += SIZE_PER_TIMESTEP_MB.pressure ?? 0;
  if (layers.wind) sizePerTimestep += SIZE_PER_TIMESTEP_MB.wind ?? 0;
  return timesteps * sizePerTimestep;
}

/** Format size for display */
function formatSize(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
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

function renderControl(opt: FlatOption, currentValue: unknown, optionsService: OptionsService, paletteService: PaletteService, cores: number): m.Children {
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

  // Special handling for pressure colors
  if (path === 'pressure.colors') {
    return m(PressureColorControl, {
      value: currentValue as PressureColorOption,
      onChange: (value: PressureColorOption) => {
        setOptionValue(optionsService, path, value);
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
      const filteredOptions = selectMeta.options.filter(o =>
        (!o.localhostOnly || isLocalhost) &&
        (!o.maxCores || cores >= o.maxCores)
      );
      return m('select.select', {
        value: currentValue,
        onchange: (e: Event) => {
          setOptionValue(optionsService, path, (e.target as HTMLSelectElement).value);
        }
      }, filteredOptions.map(o =>
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

    case 'pressure-colors':
      // Handled by special case before switch
      return null;

    case 'layer-toggle': {
      const layerToggleMeta = meta as LayerToggleMeta;
      return m('div.layer-toggle-row', [
        m('span.layer-color', {
          style: { backgroundColor: `var(--color-layer-${layerToggleMeta.layerId})` }
        }),
        m('label.toggle', [
          m('input[type=checkbox]', {
            checked: currentValue as boolean,
            onchange: (e: Event) => {
              setOptionValue(optionsService, path, (e.target as HTMLInputElement).checked);
            }
          }),
          m('span.track')
        ])
      ]);
    }
  }
}

/** Render prefetch size estimate row */
function renderPrefetchSizeEstimate(options: ZeroOptions): m.Children {
  const { prefetch } = options;
  const sizeMB = calculatePrefetchSizeMB(prefetch.forecastDays, {
    temp: prefetch.temp,
    pressure: prefetch.pressure,
    wind: prefetch.wind,
  });

  if (sizeMB === 0) {
    return m('div.row.prefetch-size', { key: '_prefetch_size' }, [
      m('div.info', [
        m('label.label', 'Estimated size'),
      ]),
      m('div.controls', [
        m('span.size-value', 'No layers selected'),
      ]),
    ]);
  }

  return m('div.row.prefetch-size', { key: '_prefetch_size' }, [
    m('div.info', [
      m('label.label', 'Estimated size'),
    ]),
    m('div.controls', [
      m('span.size-value', formatSize(sizeMB)),
    ]),
  ]);
}

function renderOption(opt: FlatOption, options: ZeroOptions, optionsService: OptionsService, paletteService: PaletteService, cores: number): m.Children {
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
      renderControl(opt, currentValue, optionsService, paletteService, cores)
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
  cores: number,
  skipGroupHeader: boolean = false
): m.Children {
  const group = optionGroups[groupId as keyof typeof optionGroups];
  if (!group) return null;

  const currentModel = options.viewport.physicsModel;

  // Filter options
  const visibleOptions = groupOptions
    .filter(o => {
      if (o.meta.hidden) return false;
      if (!showAdvancedOptions && o.meta.group === 'advanced') return false;
      if (o.meta.model && o.meta.model !== currentModel) return false;
      return true;
    })
    .sort((a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99));

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
          ...opts.map(opt => renderOption(opt, options, optionsService, paletteService, cores))
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
          ...opts.map(opt => renderOption(opt, options, optionsService, paletteService, cores))
        ])
      )
    ].filter(Boolean));
  }

  // Download group: add prefetch size estimate after layer toggles
  // Hide prefetch sub-options when prefetch.enabled is false
  if (groupId === 'download') {
    const prefetchEnabled = options.prefetch.enabled;
    const filteredOptions = visibleOptions.filter(opt => {
      // Always show the enabled toggle
      if (opt.path === 'prefetch.enabled') return true;
      // Hide other prefetch options when disabled
      if (opt.path.startsWith('prefetch.')) return prefetchEnabled;
      return true;
    });

    return m('div.section', { key: groupId }, [
      !skipGroupHeader ? m('h3.title', { key: '_title' }, group.label) : null,
      !skipGroupHeader && group.description ? m('p.description', { key: '_desc' }, group.description) : null,
      ...filteredOptions.map(opt => renderOption(opt, options, optionsService, paletteService, cores)),
      prefetchEnabled ? renderPrefetchSizeEstimate(options) : null,
    ].filter(Boolean));
  }

  return m('div.section', { key: groupId }, [
    !skipGroupHeader ? m('h3.title', { key: '_title' }, group.label) : null,
    !skipGroupHeader && group.description ? m('p.description', { key: '_desc' }, group.description) : null,
    ...visibleOptions.map(opt => renderOption(opt, options, optionsService, paletteService, cores))
  ].filter(Boolean));
}

// ============================================================
// Component
// ============================================================

export interface OptionsDialogAttrs {
  optionsService: OptionsService;
  paletteService: PaletteService;
  dialogService: DialogService;
  configService: ConfigService;
  capabilitiesService: CapabilitiesService;
}

export const OptionsDialog: m.ClosureComponent<OptionsDialogAttrs> = () => {
  return {
    view({ attrs }) {
      const { optionsService, paletteService, dialogService, configService, capabilitiesService } = attrs;
      const cores = capabilitiesService.hardwareConcurrency;

    if (!optionsService.dialogOpen) return null;

    const isFloating = dialogService.isFloating('options');
    const isTop = dialogService.isTop('options');

    const filter = optionsService.dialogFilter;
    const options = optionsService.options.value;

    // Only show options for ready layers
    const readyLayers = new Set<string>(configService.getReadyLayers());
    const isReadyOption = (opt: FlatOption) => {
      const layerId = opt.path.split('.')[0];
      // Non-layer options (viewState, gpu, etc.) are always shown
      // Layer options only shown if layer is ready
      return !layerId || !layerLabels[layerId] || readyLayers.has(layerId);
    };

    // Get options based on filter
    let filteredGroups: Record<string, FlatOption[]>;

    if (filter && filter !== 'global') {
      // Filter mode: show only options matching the filter
      const filtered = getOptionsFiltered(filter).filter(isReadyOption);
      filteredGroups = {};
      for (const opt of filtered) {
        const group = opt.meta.group;
        if (!filteredGroups[group]) filteredGroups[group] = [];
        filteredGroups[group].push(opt);
      }
    } else {
      // Global mode: show all options (respecting filter includes 'global')
      const allOptions = getOptionsFiltered('global').filter(isReadyOption);
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
      queue: 'Download',
    };
    const dialogTitle = filter && filter !== 'global'
      ? `${filterTitles[filter] ?? layerLabels[filter] ?? filter} Options`
      : 'Options';

    const isDesktop = window.innerWidth > 600;

    // Drag handlers
    const onMouseDown = (e: MouseEvent) => {
      dialogService.bringToFront('options');
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
      const win = document.querySelector<HTMLElement>('.dialog.options .window');
      if (!win) return;
      // Get base rect without current transform
      const baseX = (window.innerWidth - win.offsetWidth) / 2;
      const baseY = (window.innerHeight - win.offsetHeight) / 2;
      const headerHeight = 56;
      // Clamp so header stays in viewport
      const minX = -baseX;
      const maxX = window.innerWidth - baseX - win.offsetWidth;
      const minY = -baseY;
      const maxY = window.innerHeight - baseY - headerHeight;
      dragState.offsetX = Math.max(minX, Math.min(maxX, e.clientX - dragState.startX));
      dragState.offsetY = Math.max(minY, Math.min(maxY, e.clientY - dragState.startY));
      m.redraw();
    };

    const onMouseUp = () => {
      dragState.isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    const windowStyle: Record<string, string> = {};
    if (dragState.offsetX !== 0 || dragState.offsetY !== 0) {
      windowStyle.transform = `translate(${dragState.offsetX}px, ${dragState.offsetY}px)`;
    }

    const floatingClass = isFloating ? (isTop ? 'floating top' : 'floating behind') : '';
    const closingClass = optionsService.dialogClosing ? 'closing' : '';

    return m('div.dialog.options', { class: `${floatingClass} ${closingClass}` }, [
      m('div.backdrop', {
        onclick: () => {
          if (dialogService.shouldCloseOnBackdrop('options')) {
            resetDragState();
            optionsService.closeDialog();
          }
        }
      }),
      m('div.window', {
        class: dragState.isDragging ? 'dragging' : '',
        style: windowStyle,
        onmousedown: () => dialogService.bringToFront('options')
      }, [
        m('div.header', { onmousedown: onMouseDown }, [
          m('h2', dialogTitle),
          m('div.bar', [
            dialogService.isDesktop ? m('button.float-toggle', {
              onclick: (e: Event) => {
                e.stopPropagation();
                dialogService.toggleFloating('options');
              },
              title: isFloating ? 'Disable floating' : 'Keep floating'
            }, isFloating ? '◎' : '○') : null,
            m('button.close', {
              onclick: () => {
                resetDragState();
                optionsService.closeDialog();
              }
            }, '×')
          ])
        ]),
        m('div.content', [
          ...sortedGroupIds.map(groupId => {
            const groupOpts = filteredGroups[groupId];
            if (!groupOpts) return null;
            return renderGroup(groupId, groupOpts, options, optionsService, paletteService, showAdvanced, cores, !!filter && filter !== 'global');
          }).filter(Boolean),

          // Danger zone (only in global view, above advanced toggle)
          !filter || filter === 'global' ? m('div.danger-zone', { key: '_danger_zone' }, [
            m('h3', 'Danger Zone'),
            m('span.hint', 'Will restart the application.'),
            m('div.actions', [
              m('button.btn.btn-danger', {
                onclick: () => {
                  optionsService.reset();
                  location.reload();
                }
              }, 'Reset All'),
              m('button.btn.btn-danger', {
                onclick: async () => {
                  await clearCache();
                  location.reload();
                }
              }, 'Clear Cache'),
              m('button.btn.btn-danger', {
                onclick: () => nuke()
              }, 'Nuke'),
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
            ? renderGroup('advanced', advancedGroup, options, optionsService, paletteService, true, cores)
            : null
        ].filter(Boolean)),
        m('div.footer', [
          m('span.version', `v${__APP_VERSION__} (${__APP_HASH__})`),
          m('div.actions', [
            filter && filter !== 'global' ? m('button.btn.btn-danger', {
              onclick: () => optionsService.reset(filter)
            }, layerLabels[filter] ? 'Reset Layer' : 'Reset') : null,
            optionsService.needsReload.value ? m('button.btn.btn-secondary', {
              onclick: () => location.reload()
            }, 'Reload') : null,
            m('button.btn.btn-secondary', {
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
