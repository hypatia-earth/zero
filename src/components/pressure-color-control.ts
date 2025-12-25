/**
 * PressureColorControl - Mode selector with color chip options
 *
 * Modes:
 * - solid: All lines same color (pick from 4 presets)
 * - gradient: Blue → White → Red based on pressure (fixed)
 * - normal: 1012 hPa highlighted, others dimmed (pick highlight color)
 * - debug: Hash-based colors (localhost only)
 */

import m from 'mithril';
import type { PressureColorOption } from '../schemas/options.schema';
import { defaultConfig } from '../config/defaults';

export interface PressureColorControlAttrs {
  value: PressureColorOption;
  onChange: (value: PressureColorOption) => void;
}

type ColorMode = PressureColorOption['mode'];

interface ColorPreset {
  name: string;
  color: readonly [number, number, number, number];
}

const isLocalhost = location.hostname === 'localhost';

const colorPresets: ColorPreset[] = [
  { name: 'White', color: defaultConfig.pressureColors.white },
  { name: 'Violet', color: defaultConfig.pressureColors.violet },
  { name: 'Gold', color: defaultConfig.pressureColors.gold },
  { name: 'Teal', color: defaultConfig.pressureColors.teal },
];

function colorToCSS(c: readonly [number, number, number, number]): string {
  return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;
}

function colorsEqual(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function getSelectedPresetIndex(option: PressureColorOption): number {
  if (option.mode === 'debug' || option.mode === 'gradient') return 0;
  const targetColor = option.colors[0];
  return colorPresets.findIndex(p => colorsEqual(p.color, targetColor));
}

function buildOption(mode: ColorMode, presetIndex: number): PressureColorOption {
  const preset = colorPresets[presetIndex] ?? colorPresets[0]!;
  const color = [...preset.color] as [number, number, number, number];

  switch (mode) {
    case 'solid':
      return { mode: 'solid', colors: [color] };

    case 'gradient':
      return {
        mode: 'gradient',
        colors: [
          [...defaultConfig.pressureColors.gradient.low] as [number, number, number, number],
          [...defaultConfig.pressureColors.gradient.ref] as [number, number, number, number],
          [...defaultConfig.pressureColors.gradient.high] as [number, number, number, number],
        ],
      };

    case 'normal':
      return {
        mode: 'normal',
        colors: [
          color,
          [...defaultConfig.pressureColors.normalOther] as [number, number, number, number],
        ],
      };

    case 'debug':
      return { mode: 'debug' };
  }
}

export const PressureColorControl: m.ClosureComponent<PressureColorControlAttrs> = () => {
  return {
    view({ attrs }) {
      const { value, onChange } = attrs;
      const currentMode = value.mode;
      const selectedPreset = getSelectedPresetIndex(value);

      const modes: { mode: ColorMode; label: string; localhostOnly?: boolean }[] = [
        { mode: 'solid', label: 'Solid' },
        { mode: 'gradient', label: 'Gradient' },
        { mode: 'normal', label: 'Normal' },
        { mode: 'debug', label: 'Debug', localhostOnly: true },
      ];

      const visibleModes = modes.filter(m => !m.localhostOnly || isLocalhost);

      return m('div.pressure-color-control', [
        // Mode selection
        m('div.mode-selector', [
          visibleModes.map(({ mode, label }) =>
            m('label.mode-option', {
              key: mode,
              class: currentMode === mode ? 'selected' : '',
            }, [
              m('input[type=radio]', {
                name: 'pressure-color-mode',
                value: mode,
                checked: currentMode === mode,
                onchange: () => onChange(buildOption(mode, selectedPreset)),
              }),
              m('span', label),
            ])
          ),
        ]),

        // Color chips (only for solid and normal modes)
        currentMode === 'solid' || currentMode === 'normal'
          ? m('div.color-chips', [
              colorPresets.map((preset, i) =>
                m('button.color-chip', {
                  key: preset.name,
                  class: selectedPreset === i ? 'selected' : '',
                  style: { backgroundColor: colorToCSS(preset.color) },
                  title: preset.name,
                  onclick: () => onChange(buildOption(currentMode, i)),
                })
              ),
            ])
          : null,

        // Gradient preview
        currentMode === 'gradient'
          ? m('div.gradient-preview', {
              style: {
                background: `linear-gradient(to right, ${colorToCSS(defaultConfig.pressureColors.gradient.low)}, ${colorToCSS(defaultConfig.pressureColors.gradient.ref)}, ${colorToCSS(defaultConfig.pressureColors.gradient.high)})`,
              },
            })
          : null,

        // Debug hint
        currentMode === 'debug'
          ? m('div.debug-hint', 'Colors based on pressure value hash')
          : null,
      ]);
    },
  };
};
