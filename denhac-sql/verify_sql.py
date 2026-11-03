#!/usr/bin/env python3
"""Check a script from wxr_to_sql.py against its source export.

Usage: python verify_sql.py export.xml output.sql

Reads the SQL with its own MySQL string decoder, loads the rows into in-memory
SQLite, then compares row counts and field values with a fresh parse of the XML.
This checks the data and the string escaping. It does not prove MySQL accepts
the script, because the CREATE TABLE statements are not run.
"""
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET

WP = '{http://wordpress.org/export/1.2/}'
CONTENT = '{http://purl.org/rss/1.0/modules/content/}encoded'
UNESCAPE = {'\\': '\\', "'": "'", '0': '\0', 'n': '\n', 'r': '\r', 'Z': '\x1a'}
INSERT_RE = re.compile(r'INSERT INTO `(\w+)` \(([^)]*)\) VALUES\n')
SERIALIZED_STRING = re.compile(rb's:(\d+):"')
CR_PLACEHOLDER = ''
failures = []
carriage_returns = 0


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: {got}" + ('' if ok else f' (expected {want})'))
    if not ok:
        failures.append(label)


def serialized_ok(value):
    """Check that each s:N:"..." in a PHP-serialized value is really N bytes long."""
    data = value.encode('utf-8')
    pos = 0
    while (m := SERIALIZED_STRING.search(data, pos)):
        end = m.end() + int(m.group(1))
        if data[end:end + 1] != b'"':
            return False
        pos = end + 1
    return True


def parse_rows(sql, pos):
    """Parse (...),(...); starting at pos and return (rows, position after ;)."""
    rows = []
    while True:
        assert sql[pos] == '(', f'expected ( at {pos}'
        pos += 1
        row = []
        while True:
            if sql[pos] == "'":
                pos += 1
                chars = []
                while sql[pos] != "'":
                    if sql[pos] == '\\':
                        chars.append(UNESCAPE[sql[pos + 1]])
                        pos += 2
                    else:
                        assert sql[pos] not in '\n\r', f'raw line break in string at {pos}'
                        chars.append(sql[pos])
                        pos += 1
                pos += 1
                row.append(''.join(chars))
                global carriage_returns
                carriage_returns += row[-1].count('\r')
            else:
                m = re.compile(r'NULL|-?\d+').match(sql, pos)
                assert m, f'bad literal at {pos}'
                row.append(None if m.group() == 'NULL' else int(m.group()))
                pos = m.end()
            if sql[pos] == ',':
                pos += 1
            else:
                assert sql[pos] == ')', f'expected ) at {pos}'
                pos += 1
                break
        rows.append(row)
        if sql[pos:pos + 2] == ',\n':
            pos += 2
        else:
            assert sql[pos] == ';', f'expected ; at {pos}'
            return rows, pos + 1


def load(sql, path=':memory:'):
    db = sqlite3.connect(path)
    created = re.findall(r'^CREATE TABLE `(\w+)`', sql, re.M)
    pos = 0
    known = set()
    while (m := INSERT_RE.search(sql, pos)):
        # An INSERT only counts where a statement starts, not inside a string.
        assert sql[m.start() - 1] == '\n', f'INSERT not at line start: {m.start()}'
        cols = [c.strip(' `') for c in m.group(2).split(',')]
        table = m.group(1)
        if table not in known:
            db.execute(f"CREATE TABLE {table} ({','.join(cols)})")
            known.add(table)
        rows, pos = parse_rows(sql, m.end())
        db.executemany(f"INSERT INTO {table} VALUES ({','.join('?' * len(cols))})", rows)
    assert sql[pos:].strip() == 'COMMIT;', 'unexpected text after the last INSERT'
    check('every created table has rows', sorted(set(created) - known), [])
    return db


def main():
    xml_path, sql_path = sys.argv[1:3]
    raw = open(xml_path, 'rb').read()
    # This restores the CRs that the XML parser would otherwise drop.
    channel = ET.fromstring(raw.replace(b'\r', CR_PLACEHOLDER.encode('utf-8'))).find('channel')
    for el in channel.iter():
        if el.text:
            el.text = el.text.replace(CR_PLACEHOLDER, '\r')
    sql = open(sql_path, encoding='utf-8', newline='').read()
    db = load(sql)
    count = lambda t: db.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
    items = channel.findall('item')

    # Counted from the raw bytes, independently of the parser the converter used.
    print('-- rows against raw tag counts in the XML')
    for table, tag in (('wp_users', b'<wp:author>'), ('wp_posts', b'<item>'), ('wp_postmeta', b'<wp:postmeta>'),
                       ('wp_comments', b'<wp:comment>'), ('wp_commentmeta', b'<wp:commentmeta>'),
                       ('wxr_item_extras', b'<item>')):
        check(table, count(table), raw.count(tag))
    check('wp_usermeta', count('wp_usermeta'), raw.count(b'<wp:author>') * 2)
    check('wp_term_relationships', count('wp_term_relationships'), len(re.findall(rb'<category domain=', raw)))
    distinct = {(c.get('domain'), c.get('nicename')) for i in items for c in i.findall('category')}
    check('wp_terms', count('wp_terms'), len(distinct))
    check('wp_term_taxonomy', count('wp_term_taxonomy'), len(distinct))

    print('-- field values against the parsed XML')
    posts = {r[0]: r[1:] for r in db.execute('SELECT ID, post_content, post_title, post_status, post_name FROM wp_posts')}
    bad = sum(posts[int(i.findtext(WP + 'post_id'))] != (i.findtext(CONTENT) or '', i.findtext('title') or '',
                                                          i.findtext(WP + 'status') or '', i.findtext(WP + 'post_name') or '')
              for i in items)
    check('posts with differing content, title, status or slug', bad, 0)
    want = sorted((int(i.findtext(WP + 'post_id')), m.findtext(WP + 'meta_key') or '', m.findtext(WP + 'meta_value') or '')
                  for i in items for m in i.findall(WP + 'postmeta'))
    got = sorted(db.execute('SELECT post_id, meta_key, meta_value FROM wp_postmeta'))
    check('postmeta rows differing', sum(a != b for a, b in zip(got, want)) + abs(len(got) - len(want)), 0)
    want = sorted((int(i.findtext(WP + 'post_id')), c.get('domain'), c.get('nicename'), c.text or '')
                  for i in items for c in i.findall('category'))
    got = sorted(db.execute("""SELECT r.object_id, x.taxonomy, t.slug, t.name FROM wp_term_relationships r
        JOIN wp_term_taxonomy x ON x.term_taxonomy_id = r.term_taxonomy_id JOIN wp_terms t ON t.term_id = x.term_id"""))
    check('term assignments differing', sum(a != b for a, b in zip(got, want)) + abs(len(got) - len(want)), 0)

    print('-- carriage returns and serialized values')
    check('carriage returns in the SQL data, against raw XML bytes', carriage_returns, raw.count(b'\r'))
    check('placeholder left in the SQL', sql.count(CR_PLACEHOLDER), 0)
    serialized = [r[0] for r in db.execute(r"SELECT meta_value FROM wp_postmeta WHERE meta_value GLOB '[aO]:[0-9]*:*'")]
    print(f'     serialized postmeta values: {len(serialized)}')
    check('serialized postmeta values with wrong string lengths', sum(not serialized_ok(v) for v in serialized), 0)

    print('-- references')
    for label, query in (
        ('posts with no matching author', 'SELECT COUNT(*) FROM wp_posts WHERE post_author NOT IN (SELECT ID FROM wp_users)'),
        ('posts whose parent is not in the export',
         'SELECT COUNT(*) FROM wp_posts WHERE post_parent<>0 AND post_parent NOT IN (SELECT ID FROM wp_posts)'),
        ('comments with no matching post', 'SELECT COUNT(*) FROM wp_comments WHERE comment_post_ID NOT IN (SELECT ID FROM wp_posts)'),
    ):
        print(f'     {label}: {db.execute(query).fetchone()[0]}')

    print('-- other')
    print(f'     carriage returns in the raw XML: {raw.count(bytes([13]))}')
    print(f"     sticky items: {db.execute('SELECT COUNT(*) FROM wxr_item_extras WHERE is_sticky<>0').fetchone()[0]}")
    print(f"     attachment_url differing from guid: {db.execute('SELECT COUNT(*) FROM wxr_item_extras e JOIN wp_posts p ON p.ID=e.post_id WHERE e.attachment_url<>p.guid').fetchone()[0]}")
    print(f"""     items with a password: {db.execute("SELECT COUNT(*) FROM wp_posts WHERE post_password<>''").fetchone()[0]}""")
    print(f"     SQL bytes: {len(sql.encode('utf-8'))}")

    if failures:
        sys.exit(f'FAILED: {failures}')
    print('ALL CHECKS PASSED')


if __name__ == '__main__':
    main()
