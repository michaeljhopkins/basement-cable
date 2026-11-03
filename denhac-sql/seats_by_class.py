#!/usr/bin/env python3
"""Total booked seats per class session from an Events Manager bookings CSV.

Usage: python seats_by_class.py bookings.csv seats_by_class.csv

The bookings CSV has no event ID, so sessions are matched to events in
denhac.sqlite by title and start date. The output holds totals only, with no
names or emails. A session is every event sharing one title and date.
"""
import collections
import csv
import html
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOW = ('2025-11-01', '2026-11-01')
DATE_RE = re.compile(r'(\d{2})/(\d{2})/(\d{4})')
STATUSES = ('Approved', 'Pending', 'Waitlist', 'Cancelled')
# Spelling variants of one class, checked in order. Anything else is "Other".
FAMILIES = (
    ('Laser cutter authorization', r'laser (cutter|training)'),
    ('Woodshop A', r'^woodshop (authorization )?.?A\b'),
    ('Woodshop B', r'^woodshop (authorization )?.?B\b'),
    ('Wood lathe authorization', r'^wood lathe (authorization|training)'),
    ('FDM 3D printer authorization', r'^FDM 3D print'),
    ('Multi-tool / Prusa XL upgrade', r'multi-tool printing|prusa xl upgrade'),
    ('Resin printer authorization', r'^resin printer'),
    ('Metal shop safety', r'metal ?shop safety'),
    ('TIG welder authorization', r'^TIG (welder )?authorization'),
    ('Metal lathe authorization', r'^metal lathe auth'),
    ('Milling machine authorization', r'^milling machine auth'),
    ('CNC router authorization', r'^CNC (router )?authorization'),
    ('Intro to CAD/CAM', r'CAD/CAM'),
    ('Industrial sewing authorization', r'^industrial sewing machine auth|^how to use industrial sewing'),
    ('Industrial serger authorization', r'serger'),
    ('7-needle embroidery authorization', r'7.needle'),
    ('Stained glass classes', r'stained glass'),
)


def read_bookings(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.reader(f))
    start = next(i for i, r in enumerate(rows) if len(r) > 1)
    head = rows[start]
    return [dict(zip(head, r)) for r in rows[start + 1:] if len(r) == len(head)]


def iso_date(text):
    m = DATE_RE.search(text)
    return f'{m.group(3)}-{m.group(1)}-{m.group(2)}'


def title_key(title):
    return ' '.join(html.unescape(title).replace('’', "'").split()).casefold()


def session_note(s):
    if re.search(r'cancel', s['class'], re.I):
        return 'cancelled event'
    if re.search(r'\btest\b|\btesting\b', s['class'], re.I):
        return 'test event'
    return '' if s['matched'] else 'no matching event'


def class_family(title):
    for family, pattern in FAMILIES:
        if re.search(pattern, title, re.I):
            return family
    return 'Other classes and workshops'


def main():
    bookings = read_bookings(sys.argv[1])
    db = sqlite3.connect(f"file:{os.path.join(HERE, 'denhac.sqlite')}?mode=ro", uri=True)
    events = collections.defaultdict(list)
    for post_id, title, date, location in db.execute("""
        SELECT p.ID, p.post_title, d.meta_value, l.meta_value FROM wp_posts p
        JOIN wp_postmeta d ON d.post_id = p.ID AND d.meta_key = '_event_start_date'
        LEFT JOIN wp_postmeta l ON l.post_id = p.ID AND l.meta_key = '_location_id'
        WHERE p.post_type = 'event'"""):
        events[(title_key(title), date)].append((post_id, location))

    sessions = {}
    print('rows', len(bookings), 'statuses', collections.Counter(b['Status'] for b in bookings))
    print('multi-date rows', sum(len(DATE_RE.findall(b['Event Date(s)'])) > 1 for b in bookings))
    print('exact duplicate rows', len(bookings) - len({tuple(b.values()) for b in bookings}))
    dates = [iso_date(b['Event Date(s)']) for b in bookings]
    print('booking dates', min(dates), 'to', max(dates))
    unmatched = collections.Counter()
    for b, date in zip(bookings, dates):
        key = (title_key(b['Event']), date)
        if key not in events:
            unmatched[(b['Event'], date)] += 1
        s = sessions.setdefault(key, {'class': html.unescape(b['Event']), 'date': date,
                                      'matched': key in events, **{k: 0 for k in STATUSES}, 'other': 0})
        status = b['Status'] if b['Status'] in STATUSES else 'other'
        s[status] += int(b['Spaces'])
    print('unmatched rows', sum(unmatched.values()), 'in', len(unmatched), 'sessions')
    for (name, date), n in unmatched.most_common(15):
        print('  ', date, n, name)
    print('statuses counted as other', collections.Counter(b['Status'] for b in bookings if b['Status'] not in STATUSES))
    print('sessions sharing title and date with another event', sum(len(events[k]) > 1 for k in sessions if k in events))

    with open(sys.argv[2], 'w', encoding='utf-8', newline='') as out:
        w = csv.writer(out)
        w.writerow(['date', 'class', 'location_ids', 'seats_taken', 'pending', 'waitlist', 'cancelled', 'note'])
        for key, s in sorted(sessions.items(), key=lambda kv: (kv[1]['date'], kv[1]['class'])):
            locations = sorted({str(l) for _, l in events.get(key, [])})
            w.writerow([s['date'], s['class'], ' '.join(locations), s['Approved'], s['Pending'], s['Waitlist'], s['Cancelled'], session_note(s)])

    past = [(k, s) for k, s in sessions.items() if WINDOW[0] <= s['date'] < WINDOW[1]]
    print('\npast year: sessions', len(past), 'seats', sum(s['Approved'] for _, s in past),
          'pending', sum(s['Pending'] for _, s in past), 'waitlist', sum(s['Waitlist'] for _, s in past),
          'cancelled', sum(s['Cancelled'] for _, s in past), 'unmatched seats', sum(s['Approved'] for _, s in past if not s['matched']))
    by_class = collections.defaultdict(lambda: [0, 0, 0, 0, 0])
    for _, s in past:
        c = by_class[s['class']]
        c[0] += 1; c[1] += s['Approved']; c[2] += s['Waitlist']; c[3] += s['Cancelled']; c[4] = max(c[4], s['Approved'])
    print('class\tsessions\tseats\twaitlist\tcancelled\tmax_session')
    for name, c in sorted(by_class.items(), key=lambda kv: -kv[1][1]):
        print(f'{name}\t' + '\t'.join(map(str, c)))
    by_location = collections.Counter()
    for k, s in past:
        locs = {l for _, l in events.get(k, [])}
        label = '/'.join(sorted(locs)) if locs else 'unmatched'
        by_location[label] += s['Approved']
    print('\nseats by location', by_location.most_common())

    # Everything below leaves out sessions that did not run as real classes.
    real = [(k, s) for k, s in past if not session_note(s) or session_note(s) == 'no matching event']
    for note in ('cancelled event', 'test event', 'no matching event'):
        hit = [s for _, s in past if session_note(s) == note]
        print(f'{note}: sessions {len(hit)} seats {sum(s["Approved"] for s in hit)}')
    print('real sessions', len(real), 'seats', sum(s['Approved'] for _, s in real),
          'waitlist', sum(s['Waitlist'] for _, s in real), 'pending', sum(s['Pending'] for _, s in real))

    in_window = [b for b, d in zip(bookings, dates) if WINDOW[0] <= d < WINDOW[1]]
    seen, dup_seats = set(), collections.Counter()
    for b in in_window:
        row = tuple(b.values())
        if row in seen:
            dup_seats[b['Status']] += int(b['Spaces'])
        seen.add(row)
    print('past-year duplicate rows, extra seats by status', dict(dup_seats))
    print('past-year people with an approved seat', len({b['E-mail'].casefold() for b in in_window if b['Status'] == 'Approved'}))

    families = collections.defaultdict(lambda: [0, 0, 0, 0])
    for _, s in real:
        f = families[class_family(s['class'])]
        f[0] += 1; f[1] += s['Approved']; f[2] += s['Waitlist']; f[3] += s['Cancelled']
    print('\nfamily\tsessions\tseats\twaitlist\tcancelled\tavg')
    for name, f in sorted(families.items(), key=lambda kv: -kv[1][1]):
        print(f'{name}\t' + '\t'.join(map(str, f)) + f'\t{f[1] / f[0]:.1f}')

    booked = {k for k, s in sessions.items()}
    none = collections.Counter()
    total = 0
    for post_id, title, date in db.execute("""
        SELECT p.ID, p.post_title, d.meta_value FROM wp_posts p
        JOIN wp_postmeta d ON d.post_id = p.ID AND d.meta_key = '_event_start_date'
        WHERE p.post_type = 'event' AND p.post_status = 'publish' AND d.meta_value >= ? AND d.meta_value < ?""", WINDOW):
        total += 1
        if (title_key(title), date) not in booked:
            none[html.unescape(title)] += 1
    print('\npublished events in window', total, 'with no booking rows', sum(none.values()), none.most_common(6))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
