#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import yaml
except Exception:
    print('PyYAML is required: python3 -m pip install pyyaml', file=sys.stderr)
    sys.exit(2)

API_URL = 'https://api.ecowitt.net/api/v3/device/history'
DEFAULT_OUTPUT = Path.home() / '.pressure_log.ecowitt.jsonl'
DEFAULT_MAIN_LOG = Path.home() / '.pressure_log.jsonl'
SECRETS_PATH = Path('/Users/jtr/_JTR23_/release/home23/config/secrets.yaml')
LOCAL_TZ = dt.datetime.now().astimezone().tzinfo
TODAY_LOCAL = dt.datetime.now(LOCAL_TZ).date()


def load_secrets():
    data = yaml.safe_load(SECRETS_PATH.read_text())
    connections = data['dashboard']['tileConnections']['connections']
    ecowitt = next(c for c in connections if c.get('id') == 'jtr-ecowitt')
    return ecowitt['secrets']


def choose_cycle_type(day):
    age_days = (TODAY_LOCAL - day).days
    if age_days <= 90:
        return '5min'
    if age_days <= 365:
        return '30min'
    if age_days <= 730:
        return '4hour'
    return '1day'


def fetch_history(sec, start_dt, end_dt, cycle_type='5min', max_attempts=4):
    params = {
        'application_key': sec['applicationKey'],
        'api_key': sec['apiKey'],
        'mac': sec['mac'],
        'start_date': start_dt.strftime('%Y-%m-%d %H:%M:%S'),
        'end_date': end_dt.strftime('%Y-%m-%d %H:%M:%S'),
        'cycle_type': cycle_type,
        'call_back': 'pressure,outdoor',
        'pressure_unitid': '3',
        'temp_unitid': '1',
    }
    url = API_URL + '?' + urllib.parse.urlencode(params)

    for attempt in range(1, max_attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                payload = json.loads(resp.read().decode('utf-8'))
        except Exception:
            if attempt == max_attempts:
                raise
            time.sleep(attempt * 2)
            continue

        code = payload.get('code')
        if code == 0:
            return payload.get('data', {})

        msg = str(payload.get('msg', ''))
        if code == -1 and 'upper limit' in msg.lower() and attempt < max_attempts:
            time.sleep(attempt * 10)
            continue

        raise RuntimeError(f"Ecowitt API error: {code} {msg}")

    raise RuntimeError('Ecowitt API failed after retries')


def to_iso_local(epoch):
    return dt.datetime.fromtimestamp(int(epoch), tz=LOCAL_TZ).strftime('%Y-%m-%dT%H:%M:%S%z')


def c_to_f(c):
    return round((c * 9.0 / 5.0) + 32.0, 1)


def hpa_to_inhg(hpa):
    return round(hpa * 0.0295299830714, 2)


def hpa_to_pa(hpa):
    return int(round(hpa * 100.0))


def normalize_records(data, cycle_type):
    if isinstance(data, list):
        return []

    pressure = data.get('pressure', {})
    outdoor = data.get('outdoor', {})
    rel = (pressure.get('relative') or {}).get('list', {})
    abs_ = (pressure.get('absolute') or {}).get('list', {})
    temp = (outdoor.get('temperature') or {}).get('list', {})

    epochs = sorted(set(rel.keys()) | set(abs_.keys()) | set(temp.keys()), key=lambda x: int(x))
    out = []
    for epoch in epochs:
        rel_hpa = float(rel[epoch]) if epoch in rel and rel[epoch] not in (None, '') else None
        abs_hpa = float(abs_[epoch]) if epoch in abs_ and abs_[epoch] not in (None, '') else None
        temp_c = float(temp[epoch]) if epoch in temp and temp[epoch] not in (None, '') else None
        chosen_hpa = rel_hpa if rel_hpa is not None else abs_hpa
        if chosen_hpa is None:
            continue
        out.append({
            'ts': to_iso_local(epoch),
            'pressure_pa': hpa_to_pa(chosen_hpa),
            'pressure_inhg': hpa_to_inhg(chosen_hpa),
            'temp_c': round(temp_c, 1) if temp_c is not None else None,
            'temp_f': c_to_f(temp_c) if temp_c is not None else None,
            'pressure_hpa': round(chosen_hpa, 1),
            'pressure_relative_hpa': round(rel_hpa, 1) if rel_hpa is not None else None,
            'pressure_absolute_hpa': round(abs_hpa, 1) if abs_hpa is not None else None,
            'pressure_source_field': 'relative' if rel_hpa is not None else 'absolute',
            'source': 'ecowitt-history',
            'cycle_type': cycle_type,
        })
    return out


def daterange(start_date, end_date):
    d = start_date
    while d <= end_date:
        yield d
        d += dt.timedelta(days=1)


def load_existing(path):
    records = {}
    if not path.exists():
        return records
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            ts = row.get('ts')
            if ts:
                records[ts] = row
    return records


def write_jsonl(path, records_by_ts):
    ordered = [records_by_ts[k] for k in sorted(records_by_ts.keys())]
    with path.open('w') as f:
        for row in ordered:
            f.write(json.dumps(row, separators=(',', ':')) + '\n')
    return len(ordered)


def merge_into_main(main_path, ecowitt_records_by_ts):
    main = load_existing(main_path)
    for ts, row in ecowitt_records_by_ts.items():
        if ts in main:
            continue
        main[ts] = {
            'ts': row['ts'],
            'pressure_pa': row['pressure_pa'],
            'pressure_inhg': row['pressure_inhg'],
            'temp_c': row['temp_c'],
            'temp_f': row['temp_f'],
            'source': row['source'],
        }
    return write_jsonl(main_path, main)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start-date', required=True, help='YYYY-MM-DD')
    ap.add_argument('--end-date', required=True, help='YYYY-MM-DD')
    ap.add_argument('--output', default=str(DEFAULT_OUTPUT))
    ap.add_argument('--append-main-log', action='store_true', help='also merge core fields into ~/.pressure_log.jsonl')
    ap.add_argument('--sleep-seconds', type=float, default=0.35, help='delay between API calls')
    args = ap.parse_args()

    start_date = dt.date.fromisoformat(args.start_date)
    end_date = dt.date.fromisoformat(args.end_date)
    if end_date < start_date:
        raise SystemExit('end-date must be >= start-date')

    sec = load_secrets()
    output_path = Path(args.output)
    existing = load_existing(output_path)

    total_added = 0
    total_days = 0
    for day in daterange(start_date, end_date):
        cycle_type = choose_cycle_type(day)
        start_dt = dt.datetime.combine(day, dt.time(0, 0, 0), tzinfo=LOCAL_TZ)
        end_dt = dt.datetime.combine(day, dt.time(23, 59, 59), tzinfo=LOCAL_TZ)
        data = fetch_history(sec, start_dt, end_dt, cycle_type=cycle_type)
        rows = normalize_records(data, cycle_type)
        added = 0
        for row in rows:
            if row['ts'] not in existing:
                existing[row['ts']] = row
                added += 1
        total_added += added
        total_days += 1
        print(f'{day.isoformat()} cycle={cycle_type} rows={len(rows)} added={added}')
        time.sleep(args.sleep_seconds)

    total_written = write_jsonl(output_path, existing)
    print(f'Wrote {total_written} total records to {output_path} ({total_added} newly added across {total_days} days)')

    if args.append_main_log:
        merged = merge_into_main(DEFAULT_MAIN_LOG, existing)
        print(f'Merged into main pressure log: {merged} total rows at {DEFAULT_MAIN_LOG}')


if __name__ == '__main__':
    main()
