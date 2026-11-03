#!/usr/bin/env python3
"""Convert a WordPress WXR export to a MySQL script with WordPress-style tables.

Usage: python wxr_to_sql.py export.xml output.sql

The script creates tables but never drops them, so loading it into a database
that already has these tables fails instead of overwriting them.
"""
import re
import sys
import xml.etree.ElementTree as ET

WP = '{http://wordpress.org/export/1.2/}'
CONTENT = '{http://purl.org/rss/1.0/modules/content/}encoded'
EXCERPT = '{http://wordpress.org/export/1.2/excerpt/}encoded'
CREATOR = '{http://purl.org/dc/elements/1.1/}creator'

ZERO_DATE = '0000-00-00 00:00:00'
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$')
BATCH_ROWS = 200
BATCH_BYTES = 512 * 1024

TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci'

# Matches the WordPress core schema, so the tables work with WordPress itself.
# wxr_item_extras is the exception: it holds item fields core has no column for.
SCHEMA = {
    'wp_users': """  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_login` varchar(60) NOT NULL DEFAULT '',
  `user_pass` varchar(255) NOT NULL DEFAULT '',
  `user_nicename` varchar(50) NOT NULL DEFAULT '',
  `user_email` varchar(100) NOT NULL DEFAULT '',
  `user_url` varchar(100) NOT NULL DEFAULT '',
  `user_registered` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `user_activation_key` varchar(255) NOT NULL DEFAULT '',
  `user_status` int(11) NOT NULL DEFAULT 0,
  `display_name` varchar(250) NOT NULL DEFAULT '',
  PRIMARY KEY (`ID`),
  KEY `user_login_key` (`user_login`),
  KEY `user_nicename` (`user_nicename`),
  KEY `user_email` (`user_email`)""",
    'wp_usermeta': """  `umeta_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `meta_key` varchar(255) DEFAULT NULL,
  `meta_value` longtext DEFAULT NULL,
  PRIMARY KEY (`umeta_id`),
  KEY `user_id` (`user_id`),
  KEY `meta_key` (`meta_key`(191))""",
    'wp_options': """  `option_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `option_name` varchar(191) NOT NULL DEFAULT '',
  `option_value` longtext NOT NULL,
  `autoload` varchar(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (`option_id`),
  UNIQUE KEY `option_name` (`option_name`)""",
    'wp_posts': """  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `post_author` bigint(20) unsigned NOT NULL DEFAULT 0,
  `post_date` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `post_date_gmt` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `post_content` longtext NOT NULL,
  `post_title` text NOT NULL,
  `post_excerpt` text NOT NULL,
  `post_status` varchar(20) NOT NULL DEFAULT 'publish',
  `comment_status` varchar(20) NOT NULL DEFAULT 'open',
  `ping_status` varchar(20) NOT NULL DEFAULT 'open',
  `post_password` varchar(255) NOT NULL DEFAULT '',
  `post_name` varchar(200) NOT NULL DEFAULT '',
  `to_ping` text NOT NULL,
  `pinged` text NOT NULL,
  `post_modified` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `post_modified_gmt` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `post_content_filtered` longtext NOT NULL,
  `post_parent` bigint(20) unsigned NOT NULL DEFAULT 0,
  `guid` varchar(255) NOT NULL DEFAULT '',
  `menu_order` int(11) NOT NULL DEFAULT 0,
  `post_type` varchar(20) NOT NULL DEFAULT 'post',
  `post_mime_type` varchar(100) NOT NULL DEFAULT '',
  `comment_count` bigint(20) NOT NULL DEFAULT 0,
  PRIMARY KEY (`ID`),
  KEY `post_name` (`post_name`(191)),
  KEY `type_status_date` (`post_type`,`post_status`,`post_date`,`ID`),
  KEY `post_parent` (`post_parent`),
  KEY `post_author` (`post_author`)""",
    'wp_postmeta': """  `meta_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `post_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `meta_key` varchar(255) DEFAULT NULL,
  `meta_value` longtext DEFAULT NULL,
  PRIMARY KEY (`meta_id`),
  KEY `post_id` (`post_id`),
  KEY `meta_key` (`meta_key`(191))""",
    'wp_terms': """  `term_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(200) NOT NULL DEFAULT '',
  `slug` varchar(200) NOT NULL DEFAULT '',
  `term_group` bigint(10) NOT NULL DEFAULT 0,
  PRIMARY KEY (`term_id`),
  KEY `slug` (`slug`(191)),
  KEY `name` (`name`(191))""",
    'wp_term_taxonomy': """  `term_taxonomy_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `term_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `taxonomy` varchar(32) NOT NULL DEFAULT '',
  `description` longtext NOT NULL,
  `parent` bigint(20) unsigned NOT NULL DEFAULT 0,
  `count` bigint(20) NOT NULL DEFAULT 0,
  PRIMARY KEY (`term_taxonomy_id`),
  UNIQUE KEY `term_id_taxonomy` (`term_id`,`taxonomy`),
  KEY `taxonomy` (`taxonomy`)""",
    'wp_term_relationships': """  `object_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `term_taxonomy_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `term_order` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`object_id`,`term_taxonomy_id`),
  KEY `term_taxonomy_id` (`term_taxonomy_id`)""",
    'wp_comments': """  `comment_ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `comment_post_ID` bigint(20) unsigned NOT NULL DEFAULT 0,
  `comment_author` tinytext NOT NULL,
  `comment_author_email` varchar(100) NOT NULL DEFAULT '',
  `comment_author_url` varchar(200) NOT NULL DEFAULT '',
  `comment_author_IP` varchar(100) NOT NULL DEFAULT '',
  `comment_date` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `comment_date_gmt` datetime NOT NULL DEFAULT '0000-00-00 00:00:00',
  `comment_content` text NOT NULL,
  `comment_karma` int(11) NOT NULL DEFAULT 0,
  `comment_approved` varchar(20) NOT NULL DEFAULT '1',
  `comment_agent` varchar(255) NOT NULL DEFAULT '',
  `comment_type` varchar(20) NOT NULL DEFAULT 'comment',
  `comment_parent` bigint(20) unsigned NOT NULL DEFAULT 0,
  `user_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`comment_ID`),
  KEY `comment_post_ID` (`comment_post_ID`),
  KEY `comment_approved_date_gmt` (`comment_approved`,`comment_date_gmt`),
  KEY `comment_date_gmt` (`comment_date_gmt`),
  KEY `comment_parent` (`comment_parent`)""",
    'wp_commentmeta': """  `meta_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `comment_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `meta_key` varchar(255) DEFAULT NULL,
  `meta_value` longtext DEFAULT NULL,
  PRIMARY KEY (`meta_id`),
  KEY `comment_id` (`comment_id`),
  KEY `meta_key` (`meta_key`(191))""",
    'wxr_item_extras': """  `post_id` bigint(20) unsigned NOT NULL,
  `link` text NOT NULL,
  `pub_date` varchar(64) NOT NULL DEFAULT '',
  `description` longtext NOT NULL,
  `is_sticky` tinyint(1) NOT NULL DEFAULT 0,
  `attachment_url` text DEFAULT NULL,
  PRIMARY KEY (`post_id`)""",
}

# Longest value each short column accepts, checked before writing so that a
# value that would not fit stops the conversion.
LIMITS = {
    'wp_users': {'user_login': 60, 'user_email': 100, 'display_name': 250},
    'wp_usermeta': {'meta_key': 255},
    'wp_options': {'option_name': 191},
    'wp_posts': {'post_status': 20, 'comment_status': 20, 'ping_status': 20, 'post_password': 255,
                 'post_name': 200, 'guid': 255, 'post_type': 20},
    'wp_postmeta': {'meta_key': 255},
    'wp_terms': {'name': 200, 'slug': 200},
    'wp_term_taxonomy': {'taxonomy': 32},
    'wp_comments': {'comment_author': 255, 'comment_author_email': 100, 'comment_author_url': 200,
                    'comment_author_IP': 100, 'comment_content': 65535, 'comment_approved': 20,
                    'comment_type': 20},
    'wp_commentmeta': {'meta_key': 255},
    'wxr_item_extras': {'pub_date': 64},
}

# XML parsers turn CRLF into LF, which would change stored text and break the
# byte lengths in PHP-serialized meta values. CRs are swapped for this
# private-use character before parsing and restored when values are written.
CR_PLACEHOLDER = ''


def parse_channel(path):
    with open(path, 'rb') as f:
        raw = f.read()
    placeholder = CR_PLACEHOLDER.encode('utf-8')
    if placeholder in raw:
        raise ValueError('the export already contains the carriage return placeholder')
    return ET.fromstring(raw.replace(b'\r', placeholder)).find('channel')


ESCAPES = {'\\': '\\\\', "'": "\\'", '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z'}
ESCAPE_RE = re.compile(r"[\\'\0\n\r\x1a]")


def sql_value(value):
    if value is None:
        return 'NULL'
    if isinstance(value, int):
        return str(value)
    value = value.replace(CR_PLACEHOLDER, '\r')
    return "'" + ESCAPE_RE.sub(lambda m: ESCAPES[m.group()], value) + "'"


def text(el, tag):
    return el.findtext(tag) or ''


def integer(el, tag):
    value = text(el, tag).strip()
    return int(value) if value else 0


def date(el, tag):
    value = text(el, tag).strip()
    if not value:
        return ZERO_DATE
    if not DATE_RE.match(value):
        raise ValueError(f'unexpected date in {tag}: {value!r}')
    return value


def build_tables(channel):
    t = {name: [] for name in SCHEMA}
    columns = {}

    def add(table, **row):
        columns.setdefault(table, list(row))
        for col, limit in LIMITS.get(table, {}).items():
            if col in row and row[col] is not None and len(row[col]) > limit:
                raise ValueError(f'{table}.{col} value is {len(row[col])} long, limit {limit}')
        t[table].append(tuple(row.values()))

    options = [
        ('blogname', text(channel, 'title')),
        ('blogdescription', text(channel, 'description')),
        ('siteurl', text(channel, WP + 'base_site_url')),
        ('home', text(channel, WP + 'base_blog_url')),
        ('wxr_link', text(channel, 'link')),
        ('wxr_language', text(channel, 'language')),
        ('wxr_version', text(channel, WP + 'wxr_version')),
        ('wxr_pub_date', text(channel, 'pubDate')),
        ('wxr_generator', text(channel, 'generator')),
    ]
    image = channel.find('image')
    if image is not None:
        options += [('wxr_image_' + child.tag, child.text or '') for child in image]
    for option_id, (name, value) in enumerate(options, 1):
        add('wp_options', option_id=option_id, option_name=name, option_value=value, autoload='no')

    logins = {}
    umeta_id = 0
    for a in channel.findall(WP + 'author'):
        user_id = integer(a, WP + 'author_id')
        logins[text(a, WP + 'author_login')] = user_id
        add('wp_users', ID=user_id, user_login=text(a, WP + 'author_login'), user_email=text(a, WP + 'author_email'),
            display_name=text(a, WP + 'author_display_name'))
        for key, tag in (('first_name', 'author_first_name'), ('last_name', 'author_last_name')):
            umeta_id += 1
            add('wp_usermeta', umeta_id=umeta_id, user_id=user_id, meta_key=key, meta_value=text(a, WP + tag))

    items = channel.findall('item')
    published = {integer(i, WP + 'post_id') for i in items if text(i, WP + 'status') == 'publish'}
    terms = {}
    term_counts = {}
    relationships = set()
    meta_id = commentmeta_id = 0
    warnings = []

    for item in items:
        post_id = integer(item, WP + 'post_id')
        creator = text(item, CREATOR)
        if creator not in logins:
            warnings.append(f'post {post_id}: author {creator!r} is not in the author list; post_author set to 0')
        comments = item.findall(WP + 'comment')
        add('wp_posts',
            ID=post_id,
            post_author=logins.get(creator, 0),
            post_date=date(item, WP + 'post_date'),
            post_date_gmt=date(item, WP + 'post_date_gmt'),
            post_content=text(item, CONTENT),
            post_title=text(item, 'title'),
            post_excerpt=text(item, EXCERPT),
            post_status=text(item, WP + 'status'),
            comment_status=text(item, WP + 'comment_status'),
            ping_status=text(item, WP + 'ping_status'),
            post_password=text(item, WP + 'post_password'),
            post_name=text(item, WP + 'post_name'),
            to_ping='',
            pinged='',
            post_modified=date(item, WP + 'post_modified'),
            post_modified_gmt=date(item, WP + 'post_modified_gmt'),
            post_content_filtered='',
            post_parent=integer(item, WP + 'post_parent'),
            guid=text(item, 'guid'),
            menu_order=integer(item, WP + 'menu_order'),
            post_type=text(item, WP + 'post_type'),
            post_mime_type='',
            comment_count=sum(1 for c in comments if text(c, WP + 'comment_approved') == '1'))

        url = item.find(WP + 'attachment_url')
        add('wxr_item_extras', post_id=post_id, link=text(item, 'link'), pub_date=text(item, 'pubDate'),
            description=text(item, 'description'), is_sticky=integer(item, WP + 'is_sticky'),
            attachment_url=None if url is None else url.text or '')

        for meta in item.findall(WP + 'postmeta'):
            meta_id += 1
            add('wp_postmeta', meta_id=meta_id, post_id=post_id, meta_key=text(meta, WP + 'meta_key'),
                meta_value=text(meta, WP + 'meta_value'))

        for cat in item.findall('category'):
            key = (cat.get('domain'), cat.get('nicename'))
            name = cat.text or ''
            if key not in terms:
                terms[key] = (len(terms) + 1, name)
                term_counts[key] = 0
            elif terms[key][1] != name:
                warnings.append(f'term {key}: name {name!r} differs from {terms[key][1]!r}; kept the first')
            relationship = (post_id, terms[key][0])
            if relationship in relationships:
                warnings.append(f'post {post_id}: duplicate term {key} skipped')
                continue
            relationships.add(relationship)
            if post_id in published:
                term_counts[key] += 1
            add('wp_term_relationships', object_id=post_id, term_taxonomy_id=terms[key][0], term_order=0)

        for c in comments:
            comment_id = integer(c, WP + 'comment_id')
            add('wp_comments',
                comment_ID=comment_id,
                comment_post_ID=post_id,
                comment_author=text(c, WP + 'comment_author'),
                comment_author_email=text(c, WP + 'comment_author_email'),
                comment_author_url=text(c, WP + 'comment_author_url'),
                comment_author_IP=text(c, WP + 'comment_author_IP'),
                comment_date=date(c, WP + 'comment_date'),
                comment_date_gmt=date(c, WP + 'comment_date_gmt'),
                comment_content=text(c, WP + 'comment_content'),
                comment_approved=text(c, WP + 'comment_approved'),
                comment_type=text(c, WP + 'comment_type'),
                comment_parent=integer(c, WP + 'comment_parent'),
                user_id=integer(c, WP + 'comment_user_id'))
            for meta in c.findall(WP + 'commentmeta'):
                commentmeta_id += 1
                add('wp_commentmeta', meta_id=commentmeta_id, comment_id=comment_id,
                    meta_key=text(meta, WP + 'meta_key'), meta_value=text(meta, WP + 'meta_value'))

    # The export gives terms no IDs, so these are assigned in first-seen order.
    # Each (taxonomy, slug) gets its own term, as WordPress has done since 4.2.
    for (taxonomy, slug), (term_id, name) in terms.items():
        add('wp_terms', term_id=term_id, name=name, slug=slug)
        add('wp_term_taxonomy', term_taxonomy_id=term_id, term_id=term_id, taxonomy=taxonomy, description='',
            count=term_counts[(taxonomy, slug)])

    return t, columns, warnings


def write_inserts(out, table, cols, rows):
    head = f"INSERT INTO `{table}` ({', '.join(f'`{c}`' for c in cols)}) VALUES\n"
    batch, size = [], 0
    for row in rows:
        line = '(' + ','.join(sql_value(v) for v in row) + ')'
        batch.append(line)
        size += len(line.encode('utf-8'))
        if len(batch) >= BATCH_ROWS or size >= BATCH_BYTES:
            out.write(head + ',\n'.join(batch) + ';\n')
            batch, size = [], 0
    if batch:
        out.write(head + ',\n'.join(batch) + ';\n')


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    channel = parse_channel(sys.argv[1])
    tables, columns, warnings = build_tables(channel)
    with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as out:
        out.write('-- WordPress-style tables generated from a WXR export by wxr_to_sql.py.\n'
                  '-- Load into an empty database. Contains personal data.\n'
                  'SET NAMES utf8mb4;\n'
                  # Strict, but allowing the zero dates WordPress uses for unset dates.
                  "SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO,STRICT_TRANS_TABLES';\n"
                  'START TRANSACTION;\n\n')
        for table, ddl in SCHEMA.items():
            out.write(f'CREATE TABLE `{table}` (\n{ddl}\n) {TABLE_OPTIONS};\n\n')
        for table in SCHEMA:
            if tables[table]:
                write_inserts(out, table, columns[table], tables[table])
                out.write('\n')
        out.write('COMMIT;\n')
    for table in SCHEMA:
        print(f'{table}: {len(tables[table])}')
    for warning in warnings:
        print('WARNING:', warning)


if __name__ == '__main__':
    main()
