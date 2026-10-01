/**
 * Extracting points and areas from a KML document.
 *
 * A port of kmz_points/kml_parser.py. Namespace handling is deliberately
 * blunt: elements are matched on their local name, so KML 2.2, the legacy
 * Google Earth namespaces and namespace-less files all take the same path.
 * Matching on a fixed namespace URI is the usual reason a parser silently
 * returns zero points.
 *
 * This is the only module that needs a DOM, which is why its cross-check
 * against Python runs in a browser rather than in Node.
 *
 * Never throws: unreadable documents and malformed coordinates are reported
 * as warnings so one bad file cannot abort a batch.
 */

// Counted but not extracted. LinearRing is absent on purpose -- it lives
// inside Polygon and would count every shape twice -- and Polygon is absent
// because its areas are extracted now.
const NON_POINT_GEOMETRY = new Set(["LineString", "Model", "Track"]);

function localName(element) {
  return element.localName || element.nodeName.replace(/^.*:/, "");
}

function descendants(root, name) {
  const found = [];
  const walk = (element) => {
    for (const child of element.children) {
      if (localName(child) === name) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function childNamed(element, name) {
  for (const child of element.children) {
    if (localName(child) === name) return child;
  }
  return null;
}

function textOf(element) {
  return element ? (element.textContent || "").trim() : "";
}

/**
 * Make one key or value safe to join with `=` and `"; "`.
 *
 * Without this a value holding a semicolon reads as two pairs and a value
 * holding an equals sign moves the boundary between key and value, so two
 * different attribute sets could flatten to the same cell. The backslash is
 * escaped first: doing it last would double the ones the other two rules had
 * just added.
 *
 * A cell is one line, so tabs and newlines become a space. Only spaces are
 * trimmed off the ends -- `trim()` also removes half a dozen unicode blanks
 * that Python's `strip(" ")` leaves alone, and the two have to agree.
 */
function escapeAttribute(text) {
  return text
    .replace(/[\t\r\n]+/g, " ")
    .replace(/^ +| +$/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/;/g, "\\;");
}

/**
 * A placemark's ExtendedData flattened into one cell's worth of text.
 *
 * Two forms are read, both keyed on the `name` ATTRIBUTE:
 *
 *     <ExtendedData><Data name="k"><value>v</value></Data></ExtendedData>
 *     <ExtendedData><SchemaData><SimpleData name="k">v</SimpleData>…
 *
 * A <Data> may also carry a <displayName>. That is presentation and may
 * repeat between two different fields, so it makes a poor key and is not used
 * as one.
 *
 * Untyped namespaced children -- <ExtendedData><ns:foo>v</ns:foo></…> -- are
 * deliberately not read. There is no agreed key for them, and reading them
 * would put arbitrary vendor XML into a spreadsheet cell.
 */
function extendedData(placemark) {
  const extended = childNamed(placemark, "ExtendedData");
  if (!extended) return "";

  const pairs = [];
  // Document order, both forms interleaved, matching Python's walk.
  const walk = (parent) => {
    for (const child of parent.children) {
      const local = localName(child);
      const key =
        local === "Data" || local === "SimpleData" ? child.getAttribute("name") : null;
      // Nothing to label the value with, so there is no pair to write.
      if (key !== null) {
        const holder = local === "Data" ? childNamed(child, "value") : child;
        const text = holder ? holder.textContent || "" : "";
        pairs.push(`${escapeAttribute(key)}=${escapeAttribute(text)}`);
      }
      walk(child);
    }
  };
  walk(extended);

  return pairs.join("; ");
}

/** Reduce CDATA/HTML description markup to a single line of plain text. */
export function plainText(raw) {
  if (!raw || !raw.trim()) return "";
  if (!raw.includes("<")) return raw.split(/\s+/).join(" ");

  // A document of its own, never an element of the page's: markup given to
  // one of the page's elements loads its images and runs their onerror
  // handlers, attached or not, and a description is someone else's file. A
  // document made by DOMParser runs no script and loads nothing.
  // The whole document, not its <body>: a leading <title> lands in <head>,
  // and Python keeps its text. Tests: browser.test.mjs, kml.test.mjs.
  const holder = new DOMParser().parseFromString(raw, "text/html").documentElement;
  // Give breaks and block elements a separator, or words either side of them
  // run together once the tags are gone.
  for (const element of holder.querySelectorAll("br, p, div, li, tr")) {
    element.insertAdjacentText("afterend", "\n");
  }
  return (holder.textContent || "").split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Parse a KML `lon,lat[,alt]` triple. Returns null if unusable.
 */
export function parseCoordinate(entry) {
  const parts = entry.split(",");
  if (parts.length < 2) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const alt =
    parts.length > 2 && parts[2].trim() !== "" ? Number(parts[2]) : null;
  return { lon, lat, alt: Number.isFinite(alt) ? alt : null };
}

/**
 * Parse a whitespace-separated run of triples.
 *
 * Unusable entries are dropped rather than failing the ring: one bad corner
 * should not lose the whole shape.
 */
export function parseCoordinateList(text) {
  if (!text || !text.trim()) return [];
  return text
    .trim()
    .split(/\s+/)
    .map(parseCoordinate)
    .filter((corner) => corner !== null);
}

/**
 * The corners of a LinearRing inside an outer/inner boundary element.
 *
 * A corner carries the area's attributes: they describe the placemark the
 * ring belongs to, and a corner row on the Areas sheet is that placemark.
 */
function ringCorners(boundary, name, attributes, sourceFile) {
  const corners = [];
  for (const ring of descendants(boundary, "LinearRing")) {
    const coordinates = childNamed(ring, "coordinates");
    for (const corner of parseCoordinateList(textOf(coordinates))) {
      corners.push({
        name,
        description: "",
        lon: corner.lon,
        lat: corner.lat,
        alt: corner.alt,
        sourceFile,
        attributes,
      });
    }
  }
  return corners;
}

function parsePolygon(polygon, name, description, attributes, sourceFile) {
  const outer = [];
  for (const boundary of descendants(polygon, "outerBoundaryIs")) {
    outer.push(...ringCorners(boundary, name, attributes, sourceFile));
  }
  if (!outer.length) return null;

  const holes = [];
  for (const boundary of descendants(polygon, "innerBoundaryIs")) {
    const corners = ringCorners(boundary, name, attributes, sourceFile);
    if (corners.length) holes.push(corners);
  }

  return { name, description, outer, holes, sourceFile, attributes };
}

/**
 * Extract every Placemark Point and Polygon in a KML document.
 *
 * Returns `{points, areas, skipped, warnings}`.
 */
export function parseDocument(text, sourceFile) {
  const result = { points: [], areas: [], skipped: 0, warnings: [] };

  const parsed = new DOMParser().parseFromString(text, "application/xml");
  const failure = parsed.querySelector("parsererror");
  if (failure || !parsed.documentElement) {
    result.warnings.push("file is not valid XML and could not be read");
    return result;
  }

  for (const placemark of descendants(parsed.documentElement, "Placemark")) {
    const name = textOf(childNamed(placemark, "name"));
    const descriptionElement = childNamed(placemark, "description");
    const description = plainText(
      descriptionElement ? descriptionElement.textContent : "",
    );
    const attributes = extendedData(placemark);

    const walk = (element) => {
      for (const child of element.children) {
        if (NON_POINT_GEOMETRY.has(localName(child))) result.skipped += 1;
        walk(child);
      }
    };
    walk(placemark);
    if (NON_POINT_GEOMETRY.has(localName(placemark))) result.skipped += 1;

    for (const pointElement of descendants(placemark, "Point")) {
      const coordinates = childNamed(pointElement, "coordinates");
      const raw = textOf(coordinates);
      const first = raw.split(/\s+/)[0] || "";
      const corner = parseCoordinate(first);
      if (!corner) {
        result.warnings.push(
          `${sourceFile}: skipped ${name || "<unnamed>"} (bad coordinates)`,
        );
        continue;
      }
      result.points.push({
        name,
        description,
        lon: corner.lon,
        lat: corner.lat,
        alt: corner.alt,
        sourceFile,
        attributes,
      });
    }

    for (const polygon of descendants(placemark, "Polygon")) {
      const area = parsePolygon(polygon, name, description, attributes, sourceFile);
      if (!area) {
        result.warnings.push(
          `${sourceFile}: skipped area ${name || "<unnamed>"} (no usable outline)`,
        );
        continue;
      }
      result.areas.push(area);
    }
  }

  return result;
}
