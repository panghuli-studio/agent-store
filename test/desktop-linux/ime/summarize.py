#!/usr/bin/env python3
"""Summarize raw measurements without mistaking ASCII or empty screenshots for a pass."""
import json
from pathlib import Path
import re
import sys

out = Path(sys.argv[1])
rows = []
for path in sorted(out.glob('*.jsonl')):
    events = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    ticks = [event for event in events if event['page']['kind'] == 'tick']
    inputs = [event['page'] for event in events if event['page']['kind'] == 'input']
    text = inputs[-1]['text'] if inputs else ''
    composed = any(event['page']['kind'] == 'compositionend' for event in events)
    cjk = composed and bool(re.search(r'[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]', text))
    frames = []
    for stamp in sorted(out.glob(path.stem + '-[123].time')):
        at = float(stamp.read_text())
        previous = [event['page']['ticks'] for event in ticks if event['time'] <= at]
        ocr = stamp.with_suffix('.txt').read_text()
        native = re.findall(r'FRAME\s+(\d+)', ocr, flags=re.I)
        frames.append({'at': at, 'dom': previous[-1] if previous else None,
                       'native': int(native[-1]) if native else None})
    matches = all(frame['dom'] is not None and frame['native'] is not None
                  and abs(frame['dom'] - frame['native']) <= 1 for frame in frames)
    advances = len(frames) == 3 and all(frame['native'] is not None for frame in frames) and (
        frames[-1]['native'] > frames[0]['native'])
    rows.append({'case': path.stem, 'text': text, 'compositionend': composed, 'cjk_commit': cjk,
                 'input_events': len(inputs), 'native_focused': any(e['page'].get('focused') for e in events), 'frames': frames,
                 'native_counter_tracks_dom': bool(frames) and matches and advances,
                 'note': 'A rendering result only; no CJK coverage without a real CJK commit.'})
(out / 'summary.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
for row in rows:
    print(row['case'], 'CJK commit:', row['cjk_commit'], 'compositionend:', row['compositionend'],
          'native tracks DOM:', row['native_counter_tracks_dom'], 'text:', repr(row['text']))

packages = []
for path in sorted(out.glob('*package-1.json')):
    data = json.loads(path.read_text())
    inputs = [event.get('text', '') for event in data.get('events', []) if event['kind'] == 'input']
    packages.append({'case': path.stem, 'focused': data.get('focused'),
                     'palette': data.get('palette'), 'text': data.get('text'),
                     'cjk_commit': any(e['kind'] == 'compositionend' for e in data.get('events', [])) and any(re.search(r'[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]', text) for text in inputs)})
(out / 'package-summary.json').write_text(json.dumps(packages, ensure_ascii=False, indent=2))
