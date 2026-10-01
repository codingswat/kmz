/**
 * Enough of a DOM to run web/src/kml.js in Node. NOT a browser.
 *
 * READ THIS BEFORE TRUSTING A PASS FROM IT.
 *
 * kml.js is the one module that needs a DOM: it calls `new DOMParser()` on
 * the KML as XML, and again on the HTML inside a <description> as a document
 * of its own. Node has no DOMParser, and this repository has no
 * package.json and no node_modules on purpose, so a library is not an option.
 * What follows is a hand-written XML reader and a much smaller HTML one,
 * written to be sufficient for the three sample documents in the fixture and
 * for nothing beyond them.
 *
 * What that buys, and what it does not:
 *
 *   IT DOES check kml.js's own logic against Python -- which elements it
 *   walks, how it matches a local name, what it counts as skipped, how it
 *   pairs a Polygon's outer ring with its holes, and which coordinates it
 *   keeps. That logic is the part that drifts from kmz_points/kml_parser.py,
 *   it is a port maintained by hand, and until this shim existed none of it
 *   was covered by anything that runs in CI.
 *
 *   IT DOES NOT check that a browser's DOM behaves like this one. A pass here
 *   is evidence about kml.js, not about the pair of kml.js and Chrome. In
 *   particular this shim does NOT implement: HTML's implied end tags (a <p>
 *   left open is closed at the end of its parent, not by the next <p>), the
 *   HTML5 tree-construction algorithm in any other respect, namespace URIs
 *   and prefix resolution (local names are taken as the text after a colon,
 *   which is what kml.js looks at), entity declarations, DTDs, XML character
 *   validity, encoding detection, or CSS selectors beyond a comma-separated
 *   list of bare tag names. Anything it does not implement, it throws on,
 *   rather than quietly returning something plausible -- except a <head>:
 *   an HTML document's markup all goes in its <body>, so a leading <title>
 *   is checked in browser.test.mjs instead.
 *
 * So the browser check described in web/README.md remains the authority for
 * "kml.js works in a browser". This is the check for "kml.js agrees with
 * Python", which is a different question and was previously unasked.
 *
 * It still installs a `document`, though kml.js no longer uses one, so that
 * kml.test.mjs can see it is never asked for an element: markup given to an
 * element of the page's own document runs its script in a browser.
 */

// HTML elements that never have children and never need closing.
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(text) {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // An unusable code point is left as written, which is what a browser
      // does with an entity it cannot resolve.
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return body in NAMED_ENTITIES ? NAMED_ENTITIES[body] : whole;
  });
}

class Text {
  constructor(data) {
    this.data = data;
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

class Element {
  constructor(nodeName, attributes = new Map()) {
    this.nodeName = nodeName;
    // What a browser reports for <kml:Placemark>, and what kml.js reads.
    this.localName = nodeName.includes(":") ? nodeName.slice(nodeName.indexOf(":") + 1) : nodeName;
    this.attributes = attributes;
    this.childNodes = [];
    this.parentNode = null;
  }

  /** null for an absent attribute, which is what a browser returns. */
  getAttribute(name) {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof Element);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  append(node) {
    node.parentNode = this;
    this.childNodes.push(node);
  }

  /** Parse `markup` as HTML and make it this element's contents. */
  set innerHTML(markup) {
    this.childNodes = [];
    parseMarkup(markup, { html: true, into: this });
  }

  /** Only "afterend" is implemented; it is the only position kml.js uses. */
  insertAdjacentText(position, text) {
    if (position !== "afterend") {
      throw new Error(`dom-shim: insertAdjacentText("${position}") is not implemented`);
    }
    const parent = this.parentNode;
    if (!parent) throw new Error("dom-shim: insertAdjacentText on a node with no parent");
    const node = new Text(text);
    node.parentNode = parent;
    parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, node);
  }

  querySelectorAll(selector) {
    const wanted = tagNamesOf(selector);
    const found = [];
    const walk = (element) => {
      for (const child of element.children) {
        if (wanted.has(child.localName)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

/**
 * The only selectors this understands: one or more bare tag names separated
 * by commas. Anything else throws rather than silently matching nothing,
 * which would look like a passing test.
 */
function tagNamesOf(selector) {
  const parts = selector.split(",").map((part) => part.trim());
  for (const part of parts) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(part)) {
      throw new Error(`dom-shim: only bare tag-name selectors are implemented, got "${selector}"`);
    }
  }
  return new Set(parts.map((part) => part.toLowerCase()));
}

// name, then optionally = and a value that is double-quoted, single-quoted,
// or bare. XML requires the quotes; the bare form is here because HTML allows
// it and a description is HTML.
const ATTRIBUTE = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * The attributes of a start tag, by name.
 *
 * kml.js reads exactly one of them -- the `name` on a <Data> or <SimpleData>,
 * which is what keys an ExtendedData pair. Names are stored as written rather
 * than lowercased in HTML mode: XML is case-sensitive, that is where the only
 * attribute anyone reads lives, and nothing reads one out of a description.
 */
function attributesOf(body) {
  const found = new Map();
  for (const [, name, quoted, single, bare] of body.matchAll(ATTRIBUTE)) {
    const value = quoted ?? single ?? bare;
    // A valueless attribute is the empty string in a browser, not null.
    found.set(name, value === undefined ? "" : decodeEntities(value));
  }
  return found;
}

/** Where a tag ends, skipping any ">" inside a quoted attribute value. */
function tagEnd(source, start) {
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

/**
 * Read `source` into `into`, returning an error message or null.
 *
 * XML mode is well-formedness checked: a mismatched or unclosed tag is an
 * error, as it is in a browser. HTML mode closes what it can and ignores a
 * stray end tag, which is the small part of HTML's error recovery these
 * descriptions need -- see the header for what it deliberately does not do.
 */
function parseMarkup(source, { html, into }) {
  const stack = [into];
  const top = () => stack[stack.length - 1];
  const normalise = (name) => (html ? name.toLowerCase() : name);
  let index = 0;

  const addText = (raw, decode = true) => {
    if (!raw) return;
    top().append(new Text(decode ? decodeEntities(raw) : raw));
  };

  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next === -1) {
      addText(source.slice(index));
      break;
    }
    addText(source.slice(index, next));
    index = next;

    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index);
      if (end === -1) return "unterminated CDATA section";
      // CDATA is literal: entities inside it are not entities.
      addText(source.slice(index + "<![CDATA[".length, end), false);
      index = end + "]]>".length;
      continue;
    }

    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index);
      if (end === -1) return "unterminated comment";
      index = end + "-->".length;
      continue;
    }

    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index);
      if (end === -1) return "unterminated processing instruction";
      index = end + "?>".length;
      continue;
    }

    if (source.startsWith("<!", index)) {
      // A DOCTYPE or other declaration. Skipped, not interpreted -- this
      // reads no DTD, so a document that defines its own entities will not
      // parse the way a browser parses it.
      const end = source.indexOf(">", index);
      if (end === -1) return "unterminated declaration";
      index = end + 1;
      continue;
    }

    const end = tagEnd(source, index);
    if (end === -1) return "unterminated tag";

    if (source[index + 1] === "/") {
      const name = normalise(source.slice(index + 2, end).trim());
      index = end + 1;

      const openAt = stack.findLastIndex((element) => element.nodeName === name);
      if (openAt < 1) {
        if (!html) return `end tag </${name}> with no matching start tag`;
        continue; // a stray end tag in HTML is dropped
      }
      if (!html && openAt !== stack.length - 1) {
        return `end tag </${name}> closes ${top().nodeName}`;
      }
      stack.length = openAt;
      continue;
    }

    let body = source.slice(index + 1, end);
    index = end + 1;
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);

    const named = /^[^\s/>]+/.exec(body);
    if (!named) return "a tag with no name";
    const name = normalise(named[0]);

    const element = new Element(name, attributesOf(body.slice(named[0].length)));
    top().append(element);
    if (!selfClosing && !(html && VOID_ELEMENTS.has(name))) stack.push(element);
  }

  if (!html && stack.length > 1) return `unclosed element <${top().nodeName}>`;
  return null;
}

class XmlDocument {
  constructor(documentElement) {
    this.documentElement = documentElement;
  }

  querySelector(selector) {
    const wanted = tagNamesOf(selector);
    const root = this.documentElement;
    if (!root) return null;
    // A browser's document.querySelector can match the root itself, and the
    // parsererror element IS the root of a failed parse.
    if (wanted.has(root.localName)) return root;
    return root.querySelectorAll(selector)[0] || null;
  }
}

class DOMParserShim {
  parseFromString(source, type) {
    if (type === "text/html") {
      // Everything in <body>: none of HTML's tree construction, see the header.
      const html = new Element("html");
      const body = new Element("body");
      html.append(body);
      parseMarkup(source, { html: true, into: body });
      return { documentElement: html, body };
    }
    if (type !== "application/xml" && type !== "text/xml") {
      throw new Error(`dom-shim: parseFromString type "${type}" is not implemented`);
    }

    const holder = new Element("#document-fragment");
    const failure = parseMarkup(source, { html: false, into: holder });
    const roots = holder.children;

    const complaint =
      failure || (roots.length === 1 ? null : `expected one root element, found ${roots.length}`);
    if (complaint) {
      // A browser hands back a document whose root IS the error, which is
      // exactly what kml.js looks for.
      const error = new Element("parsererror");
      error.append(new Text(complaint));
      return new XmlDocument(error);
    }
    return new XmlDocument(roots[0]);
  }
}

/**
 * Put the shim on globalThis, so kml.js finds it where a browser would.
 *
 * Refuses to run where a real DOM is already present: silently shadowing one
 * would turn a browser run into a run of this instead.
 */
export function installDom() {
  if (globalThis.DOMParser || globalThis.document) {
    throw new Error("dom-shim: a DOM is already present; refusing to replace it");
  }
  globalThis.DOMParser = DOMParserShim;
  globalThis.document = {
    createElement(name) {
      return new Element(String(name).toLowerCase());
    },
  };
}
