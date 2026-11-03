#!/usr/bin/env python3
"""Run read-only SQL against denhac.sql, using a SQLite copy of its data.

Usage: python query.py "SELECT post_title FROM wp_posts LIMIT 5"
       python query.py --tables

The copy, denhac.sqlite, is built next to this script and rebuilt whenever
denhac.sql is newer. Queries use SQLite syntax, not MySQL.
"""
import os
import sqlite3
import sys

from verify_sql import load

HERE = os.path.dirname(os.path.abspath(__file__))
SQL_PATH = os.path.join(HERE, 'denhac.sql')
DB_PATH = os.path.join(HERE, 'denhac.sqlite')
INDEXES = ('wp_postmeta(post_id, meta_key)', 'wp_postmeta(meta_key)', 'wp_term_relationships(object_id)',
           'wp_term_relationships(term_taxonomy_id)')


def build():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    with open(SQL_PATH, encoding='utf-8', newline='') as f:
        db = load(f.read(), DB_PATH)
    for i, target in enumerate(INDEXES):
        db.execute(f'CREATE INDEX idx_{i} ON {target}')
    db.commit()
    db.close()


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    if not os.path.exists(DB_PATH) or os.path.getmtime(DB_PATH) < os.path.getmtime(SQL_PATH):
        build()
    query = sys.argv[1]
    if query == '--tables':
        query = "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name"
    db = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    cursor = db.execute(query)
    print('\t'.join(c[0] for c in cursor.description))
    count = 0
    for row in cursor:
        print('\t'.join('NULL' if v is None else str(v).replace('\r', '').replace('\n', ' ') for v in row))
        count += 1
    print(f'({count} rows)', file=sys.stderr)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
