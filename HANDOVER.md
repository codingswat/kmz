# Technical Handover — KML/KMZ Point Extractor

**Written for:** a developer re-implementing this as a feature inside a TypeScript monorepo
(React + React Router v7 + TanStack Query + Shadcn/ui; Express.js + Drizzle ORM + PostgreSQL;
bilingual Arabic/English UI).

**Assumes no access to this repository.** Every value below was read from the running code or
measured from real output, not recalled. Anything not determinable from the code is listed in
§10 rather than guessed.

**Source of truth at time of writing:** commit `89d2e07` on `main`. 449 Python tests, 46
JavaScript parity tests, all passing.

---

## 0. Orientation: what exists today

Three front ends over one shared pipeline, plus a second complete implementation in JavaScript:

| Component | Path | Role |
|---|---|---|
| Core pipeline | `kmz_points/` (Python) | Reference implementation |
| Desktop GUI | `kmz_points/gui.py` | tkinter window |
| CLI | `kmz_points/cli.py` | Headless; drives the end-to-end tests |
| LAN web service | `kmz_points/server.py`, `serve.py` | Flask + waitress, password-gated |
| Browser version | `web/src/*.js` → `web/kmz-extractor.html` | Independent JS port, zero dependencies |

**The browser version matters most to you.** It already does the whole job client-side with no
server, no dependencies and no network — it is the closest existing thing to what you are
building, and it proves the entire pipeline is viable in a browser. See §9.

The two implementations are held in lockstep by a generated-fixture cross-check: Python emits
expected values, Node asserts the JS matches. Coverage includes 485 coordinates, 155 polygons,
all 24 column definitions, every table row, area banner strings, refusal wording, and a
cell-by-cell comparison of the finished workbook.

---

## 1. Purpose & user flow

**What it does:** turns one or more KML/KMZ files into a single Excel workbook, one row per
extracted point, with each coordinate expressed in five formats, plus a second sheet measuring
any polygons.

### The user's path, end to end

1. **Get files in.** Drag-and-drop onto a drop zone, or a file picker. Multiple files at once.
   The desktop app lists each file with its point count and lets the user remove individual
   files before exporting.
2. **Configure.** Almost nothing. The *only* user-configurable input is the **output folder**
   (desktop only), which defaults to the folder of the first file added. There are no format
   options, no column choices, no coordinate-system selection, no filters. This is deliberate.
3. **Export.** One button. The tool writes `points_YYYYMMDD_HHMMSS.xlsx` and reports a summary:
   files read, points extracted, areas extracted, non-point features skipped, files failed.
4. **Get output.** Desktop writes to disk; the web service and browser version deliver a
   download.

### Failure behaviour is a core design property

**Nothing aborts a batch.** A corrupt file, a KMZ with no KML inside, a file with zero points,
a malformed coordinate, an unmeasurable polygon — each produces a warning and is skipped, and
every other file still exports. This invariant is enforced throughout: no function in the parse
or measure path raises on bad input; they return a result object carrying the reason.

Preserve this. It is the single most load-bearing behavioural decision in the codebase.

### Naming and collisions

Output filename is `points_%Y%m%d_%H%M%S.xlsx` in **local time**, not UTC — deliberately, so
the timestamp matches what the person who made it would recognise. If that path exists, a
counter is appended (`points_….xlsx`, `points_…-2.xlsx`), because two exports in the same
second previously overwrote each other while both reported success.

---

## 2. Input specification

### Elements read

| Element | How it is found | Used for |
|---|---|---|
| `<Placemark>` | Any descendant, at any depth | The unit of extraction |
| `<name>` | **Direct child** of Placemark | `Name` column |
| `<description>` | **Direct child** of Placemark | `Description` column, HTML-flattened |
| `<Point><coordinates>` | Any descendant of Placemark | Point rows |
| `<Polygon>` | Any descendant of Placemark | Areas sheet |
| `<outerBoundaryIs><LinearRing><coordinates>` | Descendant of Polygon | Polygon outline |
| `<innerBoundaryIs><LinearRing><coordinates>` | Descendant of Polygon | Polygon holes |
| `<ExtendedData><Data name="…"><value>` | Descendant of Placemark | `Attributes` column |
| `<ExtendedData><SchemaData><SimpleData name="…">` | Descendant of Placemark | `Attributes` column |

`<Folder>` and `<Document>` are **not** read as elements. They are simply traversed through —
the search is by descendant, so nesting depth is irrelevant and folder names are never recorded.
A placemark twenty folders deep is found exactly like a top-level one.

`<displayName>` inside `<Data>` is deliberately **ignored as a key**; the `name` attribute is the
key. Display names are presentation and two fields may share one.

Untyped vendor children (`<ExtendedData><ex:cost>42</ex:cost></ExtendedData>`) are deliberately
**not read** — there is no agreed key semantics for them and it would put arbitrary XML in a
spreadsheet cell.

### Geometry support

| Type | Behaviour |
|---|---|
| `Point` | **Extracted** → one row |
| `Polygon` | **Extracted** → Areas sheet, measured, corners listed |
| `MultiGeometry` | **Traversed** — Points and Polygons inside are found normally |
| `LineString` | **Counted, not extracted** → "N non-point features skipped" |
| `Model` | Counted, not extracted |
| `Track` | Counted, not extracted |
| `LinearRing` | Not counted separately — it lives inside Polygon and would double-count |

Routes/tracks being dropped is a known product gap, not an oversight; the same machinery would
give a LineString a length, and nobody had asked for it.

### Namespaces

**Matched on local name only.** Namespace URIs are never compared. The parser strips everything
up to and including `}` from the tag:

```python
def _local_name(element) -> str | None:
    tag = element.tag
    if not isinstance(tag, str):  # comments and processing instructions
        return None
    return tag.rsplit("}", 1)[-1]
```

This is deliberate and worth carrying over. It means KML 2.2
(`http://www.opengis.net/kml/2.2`), the legacy Google Earth namespaces
(`http://earth.google.com/kml/2.x`), and namespace-less documents all take the same path.
Matching on a fixed namespace URI is the usual reason a KML parser silently returns zero points.

### KMZ support

Yes. A KMZ is a zip archive. Entry selection: prefer an entry named `doc.kml` **at any depth**,
otherwise the first `*.kml` entry present. Non-KML entries (images, styles) are ignored.

**Two independent zip-bomb defences**, both required:

```python
MAX_KML_BYTES = 200 * 1024 * 1024   # 200 MB uncompressed

# 1. Refuse an honest bomb by its declared size, without touching it
info = archive.getinfo(chosen)
if info.file_size > MAX_KML_BYTES:
    raise ArchiveError(...)
# 2. Refuse a lying one by decompressing in 1 MB chunks and stopping at the cap
```

A measured 510 KB crafted KMZ expanded to 500 MB (+264 MB RSS) with no check. The declared size
alone is escapable because nothing stops an archive declaring 1 KB and carrying 300 MB.
**Carry both checks over.** `archive.read()` allocates the full declared size before you get a
chance to refuse.

### Missing and malformed fields

| Situation | Result |
|---|---|
| No `<name>` | Empty string. Warnings say `<unnamed>` |
| No `<description>` | Empty string → blank cell |
| No `<ExtendedData>` | Empty string → blank cell |
| Missing altitude (2-tuple coordinate) | `None` → blank `elevation` cell |
| Coordinate not parseable as `lon,lat` | Point skipped, warning `"{file}: skipped {name} ({reason})"`; batch continues |
| Malformed XML | lxml retried in recovery mode; warning `"file contains malformed XML; recovered what was readable"` |
| Unrecoverable XML | Warning `"file is not valid XML and could not be read"`; file skipped |
| Polygon with no usable outline | Warning `"{file}: skipped area {name} (no usable outline)"` |
| One bad corner in a ring | That corner dropped; ring kept. One bad corner should not lose a whole shape |
| KMZ with no `.kml` entry | `"{file}: archive contains no .kml file"` |
| Not a `.kml`/`.kmz` suffix | `"{file}: not a .kml or .kmz file"` |

### Real sample KML

Verbatim from `simple.kml`, one of three sample files the test suite generates and processes:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Simple</name>
    <Placemark>
      <name>Alpha</name>
      <description>A plain description</description>
      <Point><coordinates>38.123456,34.567890,120.5</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Bravo</name>
      <description>Second point</description>
      <Point><coordinates>-78.467834,-0.180653</coordinates></Point>
    </Placemark>
  </Document>
</kml>
```

Verbatim from `nested.kml` — nested folders, CDATA/HTML description, ExtendedData, a
MultiGeometry, a skipped LineString, and a polygon with a hole:

```xml
<Folder>
  <name>Outer folder</name>
  <Placemark>
    <name>Charlie</name>
    <description><![CDATA[<b>Rich</b> text with a <a href="http://example.test">link</a><br/>and a second line]]></description>
    <ExtendedData>
      <Data name="Plot ID"><displayName>Plot</displayName><value>A-12</value></Data>
      <Data name="Owner"><value>Ada; Grace</value></Data>
      <Data name="Note"><value>first line&#10;second line</value></Data>
    </ExtendedData>
    <Point><coordinates>151.215297,-33.856784,58</coordinates></Point>
  </Placemark>
  <Folder>
    <name>Inner folder</name>
    <Placemark>
      <name>Echo cluster</name>
      <MultiGeometry>
        <Point><coordinates>-0.127758,51.507351,11</coordinates></Point>
      </MultiGeometry>
    </Placemark>
  </Folder>
  <Placemark>
    <name>A route</name>
    <LineString><coordinates>1,2 3,4 5,6</coordinates></LineString>
  </Placemark>
  <Placemark>
    <name>An area</name>
    <Polygon>
      <outerBoundaryIs><LinearRing><coordinates>
        38.200000,34.600000 38.210900,34.600000
        38.210900,34.609000 38.200000,34.609000
        38.200000,34.600000
      </coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>
        38.203000,34.602000 38.205000,34.602000
        38.205000,34.604000 38.203000,34.604000
      </coordinates></LinearRing></innerBoundaryIs>
    </Polygon>
  </Placemark>
</Folder>
```

Note the `Owner` value `Ada; Grace` — it contains the pair separator, which is why the
`Attributes` serialisation escapes (§4).

---

## 3. Parsing logic

### Library

**lxml 6.1.1** (`lxml.etree` for XML, `lxml.html` for flattening CDATA descriptions).

Parser configuration, which matters for security:

```python
strict = etree.XMLParser(resolve_entities=False, no_network=True)
```

`resolve_entities=False` blocks XXE / billion-laughs entity expansion. `no_network=True` blocks
external DTD fetches. **Carry both over** — the TypeScript equivalent is choosing a parser that
does not resolve entities or fetch external resources (`fast-xml-parser` does neither by
default; browser `DOMParser` does not fetch external DTDs).

### Pipeline, step by step

```
path
 └─ read_kml_bytes()          archive.py   .kml → bytes; .kmz → unzip with bomb caps
     └─ parse_document()      kml_parser.py bytes → ParseResult{points, areas, skipped, warnings}
         └─ measure()         geometry.py  Area → MeasuredArea{area, Measurement}
             └─ build_table_rows()  table.py   [Point] → [[24 cells]]
                 └─ write_workbook()  excel.py   rows + areas → .xlsx
```

Orchestration lives in `pipeline.py`, which is deliberately the only module that knows about
more than one stage. Three front ends (GUI, CLI, web) are thin shells over it.

Detailed sequence:

1. **Resolve bytes.** Suffix check → `.kmz` unzips (preferring `doc.kml`), `.kml` reads directly.
2. **Parse XML.** Strict parse; on `XMLSyntaxError`, retry with `recover=True` and record a
   warning. If still unparseable, record a warning and return an empty result.
3. **Walk every `<Placemark>` descendant.** For each:
   a. `name` ← direct child `name`, stripped.
   b. `description` ← direct child `description`, HTML-flattened (below).
   c. `attributes` ← ExtendedData, escaped and joined (§4).
   d. Count descendants whose local name is in `{LineString, Model, Track}` → `skipped`.
   e. For each descendant `Polygon`: collect outer + inner rings → `Area`.
   f. For each descendant `Point`: parse `coordinates` → `Point`.
4. **Measure each Area** — authalic-sphere area, Vincenty perimeter (§5).
5. **Build rows** — one 24-element positional array per point, numbered from 1 across the batch.
6. **Write workbook** (§6).

### Key source, verbatim

Coordinate parsing. Note `lon,lat[,alt]` order and that a Point takes only the **first** tuple
if an exporter wrote several:

```python
def _parse_coordinate_tuple(text: str | None) -> tuple[float, float, float | None]:
    """Parse a KML ``lon,lat[,alt]`` triple. Raises ValueError if unusable."""
    if not text or not text.strip():
        raise ValueError("empty coordinates")
    # A Point holds a single tuple; take the first if an exporter wrote more.
    first = text.split()[0]
    parts = first.split(",")
    if len(parts) < 2:
        raise ValueError(f"expected lon,lat but got {first!r}")
    lon = float(parts[0])
    lat = float(parts[1])
    alt = float(parts[2]) if len(parts) > 2 and parts[2].strip() else None
    return lon, lat, alt
```

Ring parsing — unusable entries are dropped rather than failing the ring:

```python
def _parse_coordinate_list(text: str | None) -> list[tuple[float, float, float | None]]:
    if not text or not text.strip():
        return []
    corners = []
    for entry in text.split():
        try:
            corners.append(_parse_coordinate_tuple(entry))
        except (ValueError, TypeError):
            continue
    return corners
```

Description flattening — CDATA/HTML to one line of plain text. The `tail` manipulation is
essential; without it words either side of a `<br/>` run together:

```python
def _plain_text(raw: str | None) -> str:
    """Reduce CDATA/HTML description markup to a single line of plain text."""
    if not raw or not raw.strip():
        return ""
    if "<" not in raw:
        return " ".join(raw.split())
    try:
        fragment = html.fromstring(f"<div>{raw}</div>")
    except Exception:
        return " ".join(raw.split())
    # Give breaks and block elements a separator, or words either side of them
    # run together once the tags are removed.
    for element in fragment.iter():
        if _local_name(element) in ("br", "p", "div", "li", "tr"):
            element.tail = "\n" + (element.tail or "")
    return " ".join(fragment.text_content().split())
```

The main loop:

```python
for placemark in _find_descendants(root, "Placemark"):
    name_element = _find_child(placemark, "name")
    name = (name_element.text or "").strip() if name_element is not None else ""

    description_element = _find_child(placemark, "description")
    description = _plain_text(
        description_element.text if description_element is not None else None
    )

    for geometry in placemark.iter():
        if _local_name(geometry) in _NON_POINT_GEOMETRY:
            result.skipped += 1
```

`_NON_POINT_GEOMETRY = {"LineString", "Model", "Track"}`.

**Note a real subtlety:** `name` and `description` use `_find_child` (direct children only),
while geometry uses `_find_descendants`. A `<name>` nested inside a `<Point>` would not be
picked up as the placemark's name. This is correct KML but easy to get wrong on re-implementation.

**Also note:** `description_element.text` takes only the element's *text node*, not its full
subtree. For CDATA this is right. For a description containing literal child elements rather
than escaped/CDATA markup, child content would be missed. Flagged in §10.

---

## 4. Field mapping table

Excel column headers are **English only**. There is no localisation anywhere in the codebase.

| KML source | Transformation | Excel column (exact header) |
|---|---|---|
| `Placemark/name` (text) | `.strip()`; empty if absent | `Name` |
| `coordinates` field 1 | `round(lon, 6)`, stored as number | `longitude` (band *separation*) |
| `coordinates` field 2 | `round(lat, 6)`, stored as number | `latitude` (band *separation*) |
| `coordinates` field 3 | float, or `None` if absent | `elevation` |
| — | Sequential counter from 1 across the whole batch | `#` |
| `coordinates` field 1 | `format_dms(lon, "lon")` → `38° 7' 24.44" E` | `longitude` (band *Combined D,M,S*) |
| `coordinates` field 2 | `format_dms(lat, "lat")` → `34° 34' 4.40" N` | `latitude` (band *Combined D,M,S*) |
| `coordinates` field 2 | `round(lat, 6)` — repeated, carries the sign | `lat` |
| `coordinates` field 2 | `dms_parts(lat)[0]` — whole degrees, **magnitude** | `D` (first) |
| `coordinates` field 2 | `dms_parts(lat)[1]` — whole minutes, magnitude | `M` (first) |
| `coordinates` field 2 | `dms_parts(lat)[2]` — seconds, magnitude, 2 dp | `S` (first) |
| `coordinates` field 1 | `round(lon, 6)` — repeated | `long` |
| `coordinates` field 1 | `dms_parts(lon)[0]` | `D` (second) |
| `coordinates` field 1 | `dms_parts(lon)[1]` | `M` (second) |
| `coordinates` field 1 | `dms_parts(lon)[2]` | `S` (second) |
| `Placemark/description` | CDATA/HTML → single line plain text | `Description` |
| `ExtendedData/Data[@name]/value`, `SchemaData/SimpleData[@name]` | Escape `\`, `=`, `;`; tabs/newlines → space; join `key=value` with `"; "`, document order | `Attributes` |
| `coordinates` field 2 | `format_ddm(lat, "lat")` → `34° 34.0734' N` | `Lat (DDM)` |
| `coordinates` field 1 | `format_ddm(lon, "lon")` → `38° 7.4073' E` | `Lon (DDM)` |
| both | UTM zone number + latitude band letter, e.g. `38R`; blank outside −80…84 | `UTM Zone` |
| both | UTM easting, `round()` to whole metres; blank outside −80…84 | `Easting (m)` |
| both | UTM northing, `round()` to whole metres; blank outside −80…84 | `Northing (m)` |
| both | MGRS 1 m reference, e.g. `38RPN6945934271` | `MGRS` |
| — | Source filename (not path) | `Source File` |

**`Attributes` escaping**, in full — two different attribute sets must never produce the same
cell string:

- `\` → `\\`
- `=` → `\=`
- `;` → `\;`
- tabs and newlines → single space
- pairs joined with `"; "`, in document order
- absent/empty ExtendedData → `""` (never null)

Worked: `<Data name="Owner"><value>Ada; Grace</value></Data>` → `Owner=Ada\; Grace`.
Without escaping this is indistinguishable from two separate pairs `Owner=Ada` and `Grace`.

---

## 5. Coordinate handling

### Order

**KML is `longitude,latitude[,altitude]`.** The tool stores `lon`/`lat` in that order internally
and reorders only for display. This is the single most common source of bugs when
re-implementing — note that the *first* band in the spreadsheet also displays longitude before
latitude, matching KML, while most mapping APIs are lat-first.

### CRS / datum

**WGS-84 throughout.** No reprojection of input is performed and no CRS is read from the file —
KML is WGS-84 by specification. Constants:

```
semi-major axis a = 6378137.0
flattening    f = 1/298.257223563
```

### Decimal precision

| Output | Precision |
|---|---|
| Decimal degrees (stored value) | `round(x, 6)` — ~0.11 m at the equator |
| Decimal degrees (display) | Excel number format `0.000000` |
| DDM minutes | 4 dp (`34° 34.0734' N`) |
| DMS seconds | 2 dp (`34° 34' 4.40" N`) |
| UTM easting/northing | Whole metres (`round()`) |
| MGRS | 1 m precision (15-char reference) |
| Elevation | Number format `0.00`; value unrounded |

**Rounding carries between units.** Formatting 34.99999999 by truncating degrees and rounding
minutes independently gives `34° 60.0000'`, which is not a coordinate. Each formatter rounds the
smallest unit first and propagates overflow upward. Re-implement this carefully:

```python
degrees = int(magnitude)
total_minutes = (magnitude - degrees) * 60
minutes = int(total_minutes)
seconds = round((total_minutes - minutes) * 60, 2)
if seconds >= 60:
    seconds -= 60
    minutes += 1
if minutes >= 60:
    minutes -= 60
    degrees += 1
```

### D/M/S are magnitudes, not signed

The separated `D`, `M`, `S` columns hold **positive magnitudes**; the sign is deliberately not
carried. Whole degrees cannot express it for a value between −1 and 0: a latitude of `-0.180653`
is south, but its whole-degree part is `0`, and `0` has no sign. Each D/M/S triple sits beside
the signed decimal (`lat`/`long`) it was split from, and that repeated decimal is what carries
the hemisphere. **Do not "fix" this by signing D.**

### Conversions performed

| Target | Library | Notes |
|---|---|---|
| DMS / DDM | Hand-written | Pure string formatting |
| UTM | `utm` 0.9.0 | Includes Norway (zone 32) and Svalbard (31/33/35/37) exceptions |
| MGRS | `mgrs` 1.5.4 (C library binding) | Falls back to polar UPS outside −80…84 |

**UTM/MGRS are blank** where UTM is undefined — beyond 84°N or 80°S. Every other column is still
filled for those rows. MGRS itself is *not* blank there: the C library returns a UPS reference.

Longitude is folded into `[-180, 180)` before zone selection, and the angle from the zone's
central meridian is wrapped into `[-π, π]`. Both are required: without the first, longitude
exactly 180 yields "zone 61", which does not exist; without the second, a point just across the
antimeridian sits 357° from its meridian and the series expansion returns billions of metres.

### Altitude

Read from the optional third coordinate field. Stored as `float | None`. Written to `elevation`
with format `0.00`; a missing altitude leaves the cell **empty**, not zero. Altitude is
**never** used in any calculation — areas are flat map areas, not terrain-following surface
areas, because the elevation data needed for that is not in a KML.

### Area and perimeter measurement

Areas are measured on the **WGS-84 ellipsoid**, not on a projection:

- **Area:** spherical excess on the *authalic sphere* (the sphere of equal surface area,
  R = 6371007.1809 m), using the numerically stable tangent form. Geodetic latitude φ is mapped
  to authalic latitude β before summing.
- **Perimeter:** Vincenty inverse per edge, summed.
- **Holes:** measured the same way, magnitude subtracted. Winding direction is irrelevant
  because each ring's magnitude is taken.
- **Δλ is normalised into (−π, π]**, which makes antimeridian-crossing rings work with no
  special case.

Measured against `geographiclib`: 5e-12 to 3e-8 relative error on plot-sized shapes. The
previous implementation (force all corners into one UTM zone, then shoelace) was 2.0e-3.

**A shape is refused, with a reason on its banner, when:**

| Reason string | Trigger |
|---|---|
| `needs at least 3 distinct corners, found {count}` | Degenerate ring |
| `has a corner that is not a place on Earth` | lat outside ±90, lon outside ±180, NaN, ±Inf |
| `is larger than any plot this tool is meant to measure` | Bounding box > 10° either axis |
| `its outline crosses itself` | Self-intersecting outer ring |
| `has a hole that cannot be measured: it {problem}` | Any hole unmeasurable |
| `its holes cover the whole shape, leaving no area` | Net area ≤ 0 |

Self-intersection is naive all-pairs over non-adjacent edges (including the wraparound pair),
**skipped above 512 corners**. A bowtie must be refused because both the shoelace and the
ellipsoidal formula return the *signed* sum, in which the lobes cancel — the old code reported
18.54 m² for a shape spanning 1.21 km².

The 10° ceiling is a **judgement call, not a measurement**: it replaces a 6° limit that existed
only because of the projection. Every real shape in the test corpus is under 0.05°.

---

## 6. Output specification

### Library

**openpyxl 3.1.5** (with `et-xmlfile` 2.0.0). Format is `.xlsx` (OOXML).

### Sheets

Created in this order, so opening the file lands on data:

| Sheet | Exact name | When present |
|---|---|---|
| 1 | `Points` | Always |
| 2 | `Areas` | Only if the batch contains ≥1 Polygon |
| 3 | `Issues` | Only when warnings are passed — **web/browser path only** |

`Issues` exists because a browser download's response body *is* the workbook, so there is
nowhere else to report that 2 of 5 files were unreadable. The desktop app shows a dialog
instead and passes no issues. Its single column header is `Issue`, width 60.

### Layout

Both `Points` and `Areas` use the identical 24-column structure — a corner is a point that
happens to belong to a shape, so it carries every coordinate format.

- **Row 1** — band titles, merged across each band's columns, bold, size 12, centred
- **Row 2** — band captions. Only *separation* has one (`decimal degrees`). Every other band's
  row-1 title is merged **vertically** across rows 1–2 instead
- **Row 3** — column headers, bold, centred
- **Row 4+** — data
- **Freeze panes:** `A4` (all three header rows stay visible)
- **Source-file banner:** a merged, filled row spanning all 24 columns naming each source file,
  directly above its group of rows — *including* when the batch came from a single file

### Bands and fills (aarrggbb without alpha)

| Band title | Caption | Title fill | Caption fill | Columns |
|---|---|---|---|---|
| `name` | — | `D9D9D9` | — | 1 |
| `separation` | `decimal degrees` | `F8CBAD` | `BDD7EE` | 2–4 |
| `Combined D,M,S` | — | `B4C7E7` | — | 5–7 |
| `separated D,M,S` | — | `E2EFDA` | — | 8–15 |
| `details` | — | `D9D9D9` | — | 16–24 |

Banner fills: source-file and area banners `A6A6A6` with white bold text; hole sub-banners
`D9D9D9` with `1F2933` text.

### Columns — exact headers, types, formats, header fills

| # | Header | Excel type | Number format | Header fill | Font colour |
|---|---|---|---|---|---|
| 1 | `Name` | text | — | `D9D9D9` | — |
| 2 | `longitude` | number | `0.000000` | `F4B183` | — |
| 3 | `latitude` | number | `0.000000` | `F4B183` | — |
| 4 | `elevation` | number | `0.00` | `F4B183` | — |
| 5 | `#` | number | `0` | `2F5597` | `FFFFFF` |
| 6 | `longitude` | text | — | `2F5597` | `FFFFFF` |
| 7 | `latitude` | text | — | `2F5597` | `FFFFFF` |
| 8 | `lat` | number | `0.000000` | `DDEBF7` | — |
| 9 | `D` | number | `0` | `DDEBF7` | — |
| 10 | `M` | number | `0` | `DDEBF7` | — |
| 11 | `S` | number | `0.00` | `DDEBF7` | — |
| 12 | `long` | number | `0.000000` | `E2EFDA` | — |
| 13 | `D` | number | `0` | `E2EFDA` | — |
| 14 | `M` | number | `0` | `E2EFDA` | — |
| 15 | `S` | number | `0.00` | `E2EFDA` | — |
| 16 | `Description` | text | — | `D9D9D9` | — |
| 17 | `Attributes` | text | — | `D9D9D9` | — |
| 18 | `Lat (DDM)` | text | — | `D9D9D9` | — |
| 19 | `Lon (DDM)` | text | — | `D9D9D9` | — |
| 20 | `UTM Zone` | text | — | `D9D9D9` | — |
| 21 | `Easting (m)` | number | `0` | `D9D9D9` | — |
| 22 | `Northing (m)` | number | `0` | `D9D9D9` | — |
| 23 | `MGRS` | text | — | `D9D9D9` | — |
| 24 | `Source File` | text | — | `D9D9D9` | — |

**Header text is English only.** Headers repeat (`longitude` twice, `D`/`M`/`S` twice) — a header
name alone does not identify a column; the band disambiguates. Any lookup helper must take a
band argument.

**Numeric columns are stored as real numbers**, not strings, so they sort and work in formulas.
The six-decimal presentation is a *number format*, not stringification.

### Column widths

Fitted to content: `min(max(len(longest_value) + 2, 8), 60)`. Measured on the sample batch:

```
Name=14, longitude=12, latitude=12, elevation=11, #=8, longitude=19, latitude=18,
lat=12, D=8, M=8, S=8, long=12, D=8, M=8, S=8, Description=41, Attributes=60,
Lat (DDM)=16, Lon (DDM)=17, UTM Zone=10, Easting (m)=13, Northing (m)=14,
MGRS=17, Source File=13
```

### Formula injection guard

A cell value starting with `=` is prefixed with a single apostrophe, so openpyxl stores it as
literal text rather than inferring a live formula from KML-supplied content.

**`+`, `-` and `@` are deliberately NOT escaped.** They matter for CSV import, but a string
written into an `.xlsx` stays a string. Escaping them cost real data: a placemark called
`-Alpha`, or a description holding `+44 7700 900000`, was rewritten with a leading apostrophe
that then travelled with every copy, sort and re-import. **If you emit CSV, this calculus
changes and you must escape all four.**

Cells longer than 32767 characters (the xlsx hard limit) are truncated to
`value[:32764] + "..."`.

### Areas sheet structure

Per area: a banner row, then the outline's corners as ordinary point rows, then per hole a
lighter sub-banner and its corners. Corner numbering (`#`) restarts within each ring.

Banner format, exact:

```
{name} — {m²:,.0f} m² · {ha:,.3f} ha · {km²:,.6f} km² · {perimeter:,.0f} m perimeter · {n} corners
```

Real output: `An area — 957,503 m² · 95.750 ha · 0.957503 km² · 3,996 m perimeter · 4 corners`

Hole sub-banner: `hole {n} — {n} corners`

Refused: `{name} — area not measured: {reason} · {n} corners`

Separators are U+2014 EM DASH and U+00B7 MIDDLE DOT. Unnamed areas render as `<unnamed>`.
Corner count excludes KML's repeated closing corner — a square reports 4, not 5.

### Worked example

Input: the two `simple.kml` placemarks above, plus `nested.kml`. Actual output (first 7 of 24
columns; row numbers are real):

| Row | Kind | `Name` | `longitude` | `latitude` | `elevation` | `#` | `longitude` (DMS) | `latitude` (DMS) |
|---|---|---|---|---|---|---|---|---|
| 1 | band titles | `name` | `separation` | | | `Combined D,M,S` | | |
| 2 | caption | `decimal degrees` (merged over cols 2–4) | | | | | | |
| 3 | headers | `Name` | `longitude` | `latitude` | `elevation` | `#` | `longitude` | `latitude` |
| 4 | **banner** | `simple.kml` (merged across all 24) | | | | | | |
| 5 | data | `Alpha` | `38.123456` | `34.567890` | `120.5` | `1` | `38° 7' 24.44" E` | `34° 34' 4.40" N` |
| 6 | data | `Bravo` | `-78.467834` | `-0.180653` | *(blank)* | `2` | `78° 28' 4.20" W` | `0° 10' 50.35" S` |
| 7 | **banner** | `nested.kml` (merged across all 24) | | | | | | |
| 8 | data | `Charlie` | `151.215297` | `-33.856784` | `58` | `3` | `151° 12' 55.07" E` | `33° 51' 24.42" S` |

Note row 6: `Bravo` has no altitude → blank, and latitude `-0.180653` renders as `0° 10' 50.35" S`
— degrees `0`, hemisphere `S`. This is the case that motivates unsigned D/M/S.

The same batch's `Areas` sheet, rows 4–8:

| Row | Kind | Content |
|---|---|---|
| 4 | banner | `An area — 957,503 m² · 95.750 ha · 0.957503 km² · 3,996 m perimeter · 4 corners` |
| 5 | corner 1 | `An area` / `38.200000` / `34.600000` / `#=1` |
| 6 | corner 2 | `An area` / `38.210900` / `34.600000` / `#=2` |
| 7 | corner 3 | `An area` / `38.210900` / `34.609000` / `#=3` |
| 8 | corner 4 | `An area` / `38.200000` / `34.609000` / `#=4` |

Summary reported to the user for this batch: `2 files read, 5 points extracted, 1 area extracted,
1 non-point feature skipped`.

---

## 7. Edge cases & known issues

### Character encoding — Arabic/UTF-8

**Tested end to end, works correctly.** A KML with Arabic names, descriptions, and Arabic
ExtendedData *keys and values* round-trips into the workbook intact:

| Field | Input | In the workbook |
|---|---|---|
| `Name` | `بئر الماء` | `بئر الماء` |
| `Description` | `وصف عربي مع نص English مختلط` | preserved, mixed script intact |
| `Attributes` | `<Data name="المالك"><value>أحمد</value></Data>` | `المالك=أحمد` |

Mechanism: lxml reads the encoding from the XML declaration and yields `str`; openpyxl writes
UTF-8 XML inside the xlsx. **No explicit encoding handling exists anywhere in the codebase** —
it works because both libraries default correctly.

Two caveats for a bilingual product:

- **Column headers are English only.** There is no i18n layer, no locale parameter, nothing to
  switch. Bilingual headers are new work.
- **No RTL handling.** No cell alignment is set for RTL text, and no sheet is marked
  right-to-left. Excel has a sheet-level `rightToLeft` view property that is never touched.

### Very large files

| Limit | Value | Where |
|---|---|---|
| Uncompressed KML from a KMZ | **200 MB** | `archive.py` — zip-bomb defence |
| Web service upload (total) | **50 MB** | `server.py`, configurable per app |
| Uploaded filename stem | 100 chars | `server.py` |
| Excel cell content | 32,767 chars (truncated with `...`) | `excel.py` |
| Self-intersection check | skipped above **512 corners** | `geometry.py` |

**There is no row limit and no point-count limit.** The whole document is parsed into memory as
a DOM, and all points are held as objects before writing. A measured 6.7 MB KMZ containing
600,000 placemarks parsed successfully in ~6.6 s but consumed substantial memory. Excel's own
ceiling is 1,048,576 rows; the tool does not check it, so a document exceeding that would
produce a workbook Excel refuses. **Flagged as a real gap.**

### Duplicate placemarks

**No deduplication anywhere.** Two placemarks with identical names and coordinates produce two
identical rows. The desktop GUI deduplicates by *file path* when adding files to the list, but
adding the same file under two different paths loads it twice.

### Nested folders

Fully supported and depth-unlimited — the search is by descendant. **Folder names are discarded**
and no hierarchy is recorded. If the target product needs to show folder structure, that is new
work: the parser would need to accumulate ancestor folder names per placemark.

### Empty geometries

| Case | Behaviour |
|---|---|
| `<Point>` with no `<coordinates>` | Skipped with a warning |
| `<coordinates>` empty or whitespace | Skipped with a warning |
| `<Polygon>` with no usable outer ring | Skipped with a warning |
| Ring with fewer than 3 distinct corners | Area refused with a reason; corners still listed |
| File with zero placemarks | Counted as read; `0 points extracted`, no workbook if the whole batch is empty |
| Batch producing no points *and* no areas | No workbook written; summary says `No points found; nothing was written.` |

### Known to break / known limitations

1. **The `Description` column is always blank on the Areas sheet.** Corner rows hard-code
   `description=""`. An area's description is parsed and stored but never reaches a cell. This
   is a real, known defect — the `Attributes` column deliberately does *not* repeat it.
2. **`description_element.text` reads only the direct text node**, so a description containing
   literal child elements (rather than escaped or CDATA markup) loses the child content.
3. **No Excel row-count guard** (above).
4. **`LineString`/`Model`/`Track` are dropped**, counted only.
5. **Areas are flat map area**, never terrain-following.
6. **`utm`'s `force_zone_number` parameter is now unused** by the core after the switch to
   ellipsoidal measurement — it remains only in the JS port's API surface.
7. **The self-intersection check silently does not run above 512 corners** — a large
   self-intersecting ring is measured, and the number is meaningless.
8. **Bilingual/RTL output is absent** (above).

---

## 8. Dependencies

Exact pinned versions from the release lockfile (`requirements-release.txt`), which is what
shipped binaries are built from.

### Essential to core logic

| Package | Version | Role | Removable? |
|---|---|---|---|
| `lxml` | 6.1.1 | KML/XML parsing, HTML description flattening | No — but replaceable |
| `openpyxl` | 3.1.5 | xlsx generation | No — but replaceable |
| `utm` | 0.9.0 | UTM projection, zone + latitude band | No — pure maths, portable |
| `mgrs` | 1.5.4 | MGRS grid references | **See §9 — C library** |
| `packaging` | 26.3 | Only because `mgrs.core` imports it at runtime without declaring it | Incidental, but required for `mgrs` to import |
| `et-xmlfile` | 2.0.0 | Transitive dependency of `openpyxl` | No |

**Area/perimeter maths has no dependency at all** — authalic sphere and Vincenty are
hand-written in ~110 lines per language. This was a deliberate choice over `geographiclib`
(exact to millimetres) so that the Python and JavaScript implementations run the *same* formula
and agree by construction. **Carry this over; do not reach for a geodesy library.**

### Incidental — not part of the core transformation

| Package | Version | Role |
|---|---|---|
| `tkinterdnd2` | 0.6.2 | Desktop drag-and-drop. Optional at runtime — the GUI falls back to a Browse button |
| `flask` | 3.1.3 | LAN web service only |
| `waitress` | 3.0.2 | Production WSGI server for the LAN service |
| `werkzeug` / `jinja2` / `markupsafe` / `itsdangerous` / `click` / `blinker` / `colorama` | 3.1.8 / 3.1.6 / 3.0.3 / 2.2.0 / 8.4.2 / 1.9.0 / 0.4.6 | Flask transitives |
| `pytest` | 9.1.1 | Tests |
| `ruff` / `mypy` | — | Lint and types, CI-gated |

Runtime floor: **Python 3.10+**.

### The browser version's dependencies

**Zero.** `web/src/` implements zip reading, zip writing, xlsx generation, UTM, UPS, MGRS, and
the geodesy by hand, precisely because no browser-viable equivalents existed for MGRS and styled
xlsx. This is directly relevant to §9.

---

## 9. Portability notes

### The single most useful fact

**A complete, dependency-free JavaScript implementation of this entire pipeline already exists
in this repo** at `web/src/` (~10 modules), bundled to a single self-contained
`web/kmz-extractor.html`. It runs the whole conversion client-side — no server, no uploads,
works offline — and is verified cell-by-cell against the Python output by CI.

**Get this code.** It is a far better starting point than re-implementing from this document,
and it resolves every hard portability question below by demonstration.

### What does not map directly

| Python | Problem | Suggested equivalent |
|---|---|---|
| `mgrs` 1.5.4 | **Binds a compiled C library.** No npm equivalent, no WASM build in common use | The repo's `web/src/convert.js` implements UTM + UPS + MGRS by hand and matches the C library across 485 coordinates including both poles. Port it |
| `lxml` | CPython C extension | `fast-xml-parser` (Node + browser), or native `DOMParser` in the browser. **Ensure entity resolution and external DTD fetching are off** |
| `lxml.html` for descriptions | HTML5 parsing of CDATA | Browser: a detached element + `textContent`, inserting separators before `br,p,div,li,tr`. Node: `linkedom` or `node-html-parser`. The repo's `web/src/kml.js` does this without dependencies |
| `openpyxl` | Python-only | **`exceljs`** — supports merged cells, fills, fonts, number formats, freeze panes and column widths, and runs in the browser. SheetJS community build drops most styling and would lose the banded header design |
| `zipfile` (KMZ) | stdlib | `fflate` (tiny, browser+Node) or `jszip`. **Re-implement both bomb caps** — check the declared size *and* decompress in bounded chunks |
| `utm` | Pure Python | Port directly, or `utm-latlng`. Verify the Norway/Svalbard exceptions and the `[-180,180)` fold |
| tkinter GUI | Desktop-only | Not applicable — replaced by React |
| Flask/waitress | Server | Express, which you already have |

### Can generation run fully client-side?

**Yes — proven.** The browser version does exactly this today with no server involvement and no
dependencies. For your architecture that means a genuine choice:

- **Client-side (React + `exceljs`)**: the file never leaves the browser, no upload limit, no
  server CPU/memory, works offline. Strong privacy story — the existing tool advertises exactly
  this. Downside: no server-side record of the conversion, and a very large file is bounded by
  browser memory.
- **Server-side (Express)**: lets you persist runs to PostgreSQL via Drizzle, enforce
  auth/quotas, and handle files larger than browser memory. Downside: uploads, storage, and
  transfer of potentially sensitive location data.

Given a production system with a database, a hybrid is probably right: parse and preview
client-side for responsiveness, and offer server-side export when the user wants the result
recorded. Decide deliberately — see §10.

### Behaviours that must survive the port

1. **Nothing raises on bad input**; one bad file never aborts a batch.
2. **Local-name-only element matching** — never compare namespace URIs.
3. **Rounding carries** in DMS/DDM formatting.
4. **D/M/S unsigned**, with the signed decimal beside them.
5. **Both zip-bomb caps.**
6. **The `=` formula guard**, and *not* escaping `+`/`-`/`@` for xlsx (but *do* escape all four
   if you emit CSV).
7. **Numeric cells stored as numbers**, with presentation via number format.
8. **`Attributes` escaping** — two different attribute sets must never collide.
9. **The area/perimeter formulas run identically** wherever they run, if you keep two
   implementations.
10. **File text never becomes page markup.** A description is someone else's HTML: reduce it
    in a document of its own (`DOMParser`), never through `innerHTML` on an element of the
    page, which loads `<img src=x onerror=...>` and runs it even when detached. Put warnings
    and errors (they quote placemark and file names) on the page as text. Fixed in the
    browser version 2026-10-01; `web/test/browser.test.mjs` checks it in Chrome.

### A word on maintaining two implementations

This repo carries Python and JavaScript versions of the same logic. The cost is real: every
feature is built twice. It is survivable only because of the generated-fixture cross-check,
which was found to be **partly fictitious** during a recent audit — a test named "the produced
workbook is identical to Python's" compared nothing of the sort, and had never done so. Once a
real comparison was built it immediately surfaced a genuine numeric bug and three coordinate
defects.

**If you are consolidating to one TypeScript implementation, that problem disappears — take that
option.** If you keep a second implementation for any reason, build the cross-check first and
make sure it can actually fail.

---

## 10. Open decisions

Things the code does not determine, which the receiving developer must decide.

### Product

1. **Bilingual headers.** Column headers are English-only with no i18n layer. Do Arabic headers
   translate the text, duplicate it (`الاسم / Name`), or switch by locale? `Name`, `#`, `D`,
   `M`, `S`, `MGRS`, `UTM Zone` have no obvious Arabic equivalents, and `D`/`M`/`S` repeat.
2. **RTL worksheets.** Should the sheet be marked right-to-left, and cells RTL-aligned, when the
   UI locale is Arabic? Excel supports it; the tool never sets it.
3. **Client-side vs server-side generation** (§9). This is the biggest architectural decision
   and it is genuinely open.
4. **Persistence.** With PostgreSQL available, should extracted points be stored (queryable,
   re-exportable) or is the workbook the only artefact? Nothing in this codebase persists
   anything — the LAN service explicitly retains nothing.
5. **Should `LineString` be extracted?** Deferred here, not refused. The same machinery gives a
   path a length and its vertices are points. Likely wanted in a production GIS-adjacent system.
6. **Folder hierarchy.** Folder names are discarded. If users organise by folder and expect that
   in the output, the parser must accumulate ancestor names — new work.
7. **Deduplication.** None exists. Should identical placemarks collapse?
8. **The 10° extent ceiling** is a judgement call, not a measurement. Confirm it against real
   customer files; raise it if legitimate large holdings are refused.
9. **Should the Areas sheet's `Description` column be fixed?** It is blank today (§7.1) —
   arguably a bug, but changing it changes output.

### Technical

10. **Excel row limit.** Nothing guards against exceeding 1,048,576 rows. Decide: chunk across
    sheets, paginate, refuse with a clear message, or stream.
11. **MGRS at the poles.** The Python side uses a C library that falls back to UPS; the JS port
    implements UPS by hand. Confirm which behaviour you want, and whether polar coverage matters
    at all for your users.
12. **Very large file strategy.** The current design is fully in-memory (DOM + all objects).
    A streaming parser (SAX-style) would change the architecture but lift the ceiling. Decide
    based on realistic file sizes — which I could not determine from the code.
13. **Whether `Attributes` should stay one packed cell** or explode into per-key columns. The
    packed form was chosen to keep `COLUMNS` a fixed list; with a database and a dynamic UI,
    per-key columns may be better, and the escaping scheme is designed to be losslessly
    parseable back into pairs.
14. **Number formats and fills** are tuned to a specific original spreadsheet mock-up whose
    provenance is not in the repo. If the production system has a design system, these colours
    (`F4B183`, `2F5597`, `DDEBF7`, `E2EFDA`, `D9D9D9`, `B4C7E7`, `F8CBAD`, `BDD7EE`) will
    likely need replacing — but they *are* what current users see.
15. **Timezone of the output filename.** Local time today. In a server-side product with users
    in multiple timezones this becomes ambiguous.

### Not determinable from this repository

16. **Who the users are and what their real files look like.** Every sample and fixture in this
    repo is synthetic. Sizes, typical point counts, whether polygons are common, whether
    ExtendedData is used in practice, and whether Arabic content appears in real files are all
    unknown here. Several decisions above (10, 12, 8) should be made against real data.
17. **Whether the 5-coordinate-format output is actually used**, or whether users only ever look
    at one or two. The 24-column layout is inherited from an original specification not present
    in the repo. Worth asking before reproducing it wholesale.
