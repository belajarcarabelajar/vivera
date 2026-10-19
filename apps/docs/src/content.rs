use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde::de::value::MapDeserializer;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Lang {
    En,
    Id,
}

impl Lang {
    pub const ALL: [Lang; 2] = [Lang::En, Lang::Id];

    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Id => "id",
        }
    }

    pub fn other(self) -> Lang {
        match self {
            Lang::En => Lang::Id,
            Lang::Id => Lang::En,
        }
    }
}

impl fmt::Display for Lang {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

/// Declaration order is the site order of categories.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Category {
    GettingStarted,
    Pipeline,
    Tooling,
    Reference,
    Integrations,
}

impl Category {
    pub const ALL: [Category; 5] = [
        Category::GettingStarted,
        Category::Pipeline,
        Category::Tooling,
        Category::Reference,
        Category::Integrations,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Category::GettingStarted => "getting-started",
            Category::Pipeline => "pipeline",
            Category::Tooling => "tooling",
            Category::Reference => "reference",
            Category::Integrations => "integrations",
        }
    }

    pub fn from_slug(slug: &str) -> Option<Category> {
        Category::ALL.into_iter().find(|c| c.slug() == slug)
    }

    pub fn label(self, lang: Lang) -> &'static str {
        match (self, lang) {
            (Category::GettingStarted, Lang::En) => "Getting started",
            (Category::GettingStarted, Lang::Id) => "Memulai",
            (Category::Pipeline, _) => "Pipeline",
            (Category::Tooling, Lang::En) => "Tooling",
            (Category::Tooling, Lang::Id) => "Perkakas",
            (Category::Reference, Lang::En) => "Reference",
            (Category::Reference, Lang::Id) => "Referensi",
            (Category::Integrations, Lang::En) => "Integrations",
            (Category::Integrations, Lang::Id) => "Integrasi",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frontmatter {
    pub title: String,
    pub description: String,
    pub category: String,
    pub slug: String,
    #[serde(deserialize_with = "de_order")]
    pub order: u32,
    pub source: String,
    pub source_hash: String,
}

fn de_order<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let raw = String::deserialize(d)?;
    raw.parse()
        .map_err(|_| serde::de::Error::custom(format!("order must be a whole number, got `{raw}`")))
}

/// Reads the `key: value` subset of YAML that docs-gen writes. Values stay
/// strings until serde checks the key set, so a missing or unknown key is
/// reported by name.
pub fn parse_frontmatter(src: &str) -> Result<(Frontmatter, &str), String> {
    let rest = src
        .strip_prefix("---\n")
        .ok_or("frontmatter must open with a `---` line")?;
    let (block, body) = match rest.find("\n---\n") {
        Some(i) => (&rest[..i], &rest[i + 5..]),
        None => return Err("frontmatter has no closing `---` line".into()),
    };
    let mut pairs = Vec::new();
    for (i, line) in block.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let (key, raw) = line
            .split_once(':')
            .ok_or_else(|| format!("frontmatter line {}: expected `key: value`", i + 2))?;
        let value =
            scalar(raw.trim()).map_err(|e| format!("frontmatter key `{key}`: {e}"))?;
        pairs.push((key.to_string(), value));
    }
    let de: MapDeserializer<'_, _, serde::de::value::Error> = MapDeserializer::new(pairs.into_iter());
    let fm = Frontmatter::deserialize(de).map_err(|e| e.to_string())?;
    Ok((fm, body))
}

fn scalar(raw: &str) -> Result<String, String> {
    if let Some(inner) = raw.strip_prefix('"') {
        double_quoted(inner)
    } else if let Some(inner) = raw.strip_prefix('\'') {
        single_quoted(inner)
    } else if raw.starts_with(['|', '>']) {
        Err("block scalars are not supported, write the value on one line".into())
    } else {
        Ok(raw.to_string())
    }
}

fn double_quoted(inner: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return closed(out, chars.as_str()),
            '\\' => match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('/') => out.push('/'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => return Err(format!("unsupported escape `\\{other}`")),
                None => break,
            },
            c => out.push(c),
        }
    }
    Err("unterminated double-quoted value".into())
}

fn single_quoted(inner: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\'' {
            out.push(c);
        } else if chars.peek() == Some(&'\'') {
            chars.next();
            out.push('\'');
        } else {
            return closed(out, &chars.collect::<String>());
        }
    }
    Err("unterminated single-quoted value".into())
}

fn closed(value: String, rest: &str) -> Result<String, String> {
    if rest.trim().is_empty() {
        Ok(value)
    } else {
        Err(format!("unexpected text after the closing quote: `{}`", rest.trim()))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DocPage {
    pub lang: Lang,
    pub file: String,
    pub category: Category,
    pub slug: String,
    pub order: u32,
    pub title: String,
    pub description: String,
    pub body: String,
}

impl DocPage {
    pub fn parse(lang: Lang, file: &str, src: &str) -> Result<DocPage, ContentError> {
        let (fm, body) = parse_frontmatter(src).map_err(|message| ContentError::Frontmatter {
            lang,
            file: file.to_string(),
            message,
        })?;
        let category =
            Category::from_slug(&fm.category).ok_or_else(|| ContentError::UnknownCategory {
                lang,
                file: file.to_string(),
                category: fm.category.clone(),
            })?;
        Ok(DocPage {
            lang,
            file: file.to_string(),
            category,
            slug: fm.slug,
            order: fm.order,
            title: fm.title,
            description: fm.description,
            body: body.to_string(),
        })
    }

    pub fn is_intro(&self) -> bool {
        self.category == Category::GettingStarted && self.slug == "introduction"
    }

    fn key(&self) -> String {
        format!("{}/{}", self.category.slug(), self.slug)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContentError {
    Io {
        path: String,
        message: String,
    },
    Frontmatter {
        lang: Lang,
        file: String,
        message: String,
    },
    UnknownCategory {
        lang: Lang,
        file: String,
        category: String,
    },
    Duplicate {
        lang: Lang,
        first: String,
        second: String,
        key: String,
    },
    MissingTwin {
        lang: Lang,
        file: String,
        key: String,
        missing: Lang,
    },
    Part {
        lang: Lang,
        file: String,
        message: String,
    },
}

impl fmt::Display for ContentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ContentError::Io { path, message } => write!(f, "{path}: {message}"),
            ContentError::Frontmatter { lang, file, message } => {
                write!(f, "{lang}/{file}: {message}")
            }
            ContentError::UnknownCategory { lang, file, category } => {
                write!(f, "{lang}/{file}: unknown category `{category}`")
            }
            ContentError::Duplicate { lang, first, second, key } => {
                write!(f, "{lang}: {first} and {second} both define {key}")
            }
            ContentError::MissingTwin { lang, file, key, missing } => {
                write!(f, "{lang}/{file} ({key}) has no {missing} twin")
            }
            ContentError::Part { lang, file, message } => write!(f, "{lang}/{file}: {message}"),
        }
    }
}

impl std::error::Error for ContentError {}

pub fn load_dir(lang: Lang, dir: &Path) -> Result<Vec<DocPage>, ContentError> {
    let io = |path: &Path, e: std::io::Error| ContentError::Io {
        path: path.display().to_string(),
        message: e.to_string(),
    };
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| io(dir, e))? {
        let path = entry.map_err(|e| io(dir, e))?.path();
        if path.extension().is_some_and(|x| x == "md") {
            files.push(path);
        }
    }
    files.sort();
    let named = files
        .iter()
        .map(|path| {
            let src = fs::read_to_string(path).map_err(|e| io(path, e))?;
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            Ok((name.to_string(), src))
        })
        .collect::<Result<Vec<_>, ContentError>>()?;
    crate::parts::assemble(lang, named)
}

#[derive(Debug)]
pub struct Site {
    pages: Vec<DocPage>,
}

impl Site {
    pub fn new(mut pages: Vec<DocPage>) -> Result<Site, ContentError> {
        pages.sort_by(|a, b| {
            (a.lang, a.category, a.order, &a.title, &a.file)
                .cmp(&(b.lang, b.category, b.order, &b.title, &b.file))
        });
        {
            let mut seen: HashMap<(Lang, Category, &str), &DocPage> = HashMap::new();
            for page in &pages {
                if let Some(first) = seen.insert((page.lang, page.category, &page.slug), page) {
                    return Err(ContentError::Duplicate {
                        lang: page.lang,
                        first: first.file.clone(),
                        second: page.file.clone(),
                        key: page.key(),
                    });
                }
            }
            for page in &pages {
                let missing = page.lang.other();
                if !seen.contains_key(&(missing, page.category, page.slug.as_str())) {
                    return Err(ContentError::MissingTwin {
                        lang: page.lang,
                        file: page.file.clone(),
                        key: page.key(),
                        missing,
                    });
                }
            }
        }
        Ok(Site { pages })
    }

    pub fn reading_order(&self, lang: Lang) -> Vec<&DocPage> {
        self.pages.iter().filter(|p| p.lang == lang).collect()
    }

    pub fn find(&self, lang: Lang, category: Category, slug: &str) -> Option<&DocPage> {
        self.pages
            .iter()
            .find(|p| p.lang == lang && p.category == category && p.slug == slug)
    }

    #[cfg(test)]
    pub fn twin(&self, page: &DocPage) -> Option<&DocPage> {
        self.find(page.lang.other(), page.category, &page.slug)
    }

    pub fn categories(&self, lang: Lang) -> Vec<Category> {
        self.sidebar(lang).into_iter().map(|(c, _)| c).collect()
    }

    pub fn sidebar(&self, lang: Lang) -> Vec<(Category, Vec<&DocPage>)> {
        Category::ALL
            .into_iter()
            .map(|c| {
                let pages = self
                    .pages
                    .iter()
                    .filter(|p| p.lang == lang && p.category == c)
                    .collect::<Vec<_>>();
                (c, pages)
            })
            .filter(|(_, pages)| !pages.is_empty())
            .collect()
    }

    pub fn pager(&self, page: &DocPage) -> (Option<&DocPage>, Option<&DocPage>) {
        let order = self.reading_order(page.lang);
        match order
            .iter()
            .position(|p| p.category == page.category && p.slug == page.slug)
        {
            Some(i) => (
                i.checked_sub(1).map(|j| order[j]),
                order.get(i + 1).copied(),
            ),
            None => (None, None),
        }
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn source(category: &str, slug: &str, order: u32, title: &str) -> String {
        format!(
            "---\ntitle: {title}\ndescription: About {title}.\ncategory: {category}\n\
             slug: {slug}\norder: {order}\nsource: README.md\nsource_hash: \"0123456789ab\"\n\
             ---\n\n# {title}\n\nBody of {title}.\n"
        )
    }

    pub fn page(lang: Lang, category: &str, slug: &str, order: u32, title: &str) -> DocPage {
        let file = format!("{category}-{slug}.md");
        DocPage::parse(lang, &file, &source(category, slug, order, title)).unwrap()
    }

    /// Insertion order is deliberately not the site order: integrations comes
    /// before tooling, and beta before alpha.
    pub fn pages() -> Vec<DocPage> {
        let mut out = Vec::new();
        for (lang, intro, quick, alpha) in [
            (Lang::En, "Introduction", "Quick Start", "Alpha"),
            (Lang::Id, "Pengantar", "Mulai Cepat", "Alfa"),
        ] {
            out.push(page(lang, "integrations", "graphify", 1, "Graphify"));
            out.push(page(lang, "tooling", "beta", 2, "Beta"));
            out.push(page(lang, "tooling", "alpha", 2, alpha));
            out.push(page(lang, "tooling", "zeta", 1, "Zeta"));
            out.push(page(lang, "getting-started", "quick-start", 2, quick));
            out.push(page(lang, "getting-started", "introduction", 1, intro));
        }
        out
    }

    pub fn site() -> Site {
        Site::new(pages()).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{page, pages, site, source};
    use super::*;

    #[test]
    fn frontmatter_valid_parses_every_key_and_returns_the_body() {
        let src = "---\ntitle: \"Plan Mirroring: Obsidian and GitHub Issues\"\n\
                   description: Mirrors plans.\ncategory: pipeline\nslug: plan-mirroring\n\
                   order: 7\nsource: README.md#plan-mirroring\nsource_hash: \"6419418e6221\"\n\
                   ---\n\n# Plan Mirroring\n";
        let (fm, body) = parse_frontmatter(src).unwrap();
        assert_eq!(
            fm,
            Frontmatter {
                title: "Plan Mirroring: Obsidian and GitHub Issues".into(),
                description: "Mirrors plans.".into(),
                category: "pipeline".into(),
                slug: "plan-mirroring".into(),
                order: 7,
                source: "README.md#plan-mirroring".into(),
                source_hash: "6419418e6221".into(),
            }
        );
        assert_eq!(body, "\n# Plan Mirroring\n");
    }

    #[test]
    fn frontmatter_missing_key_is_an_error_naming_it() {
        let src = source("tooling", "zeta", 1, "Zeta").replace("slug: zeta\n", "");
        let err = parse_frontmatter(&src).unwrap_err();
        assert!(err.contains("missing field `slug`"), "{err}");
    }

    #[test]
    fn frontmatter_unknown_key_is_rejected() {
        let src = source("tooling", "zeta", 1, "Zeta").replace("order: 1\n", "order: 1\ncolor: red\n");
        let err = parse_frontmatter(&src).unwrap_err();
        assert!(err.contains("unknown field `color`"), "{err}");
    }

    #[test]
    fn frontmatter_quoted_values_follow_yaml_quoting() {
        let src = source("tooling", "zeta", 1, "Zeta")
            .replace("title: Zeta\n", "title: 'It''s \"Zeta\": quoted'\n")
            .replace("description: About Zeta.\n", "description: \"Say \\\"hi\\\" \\\\ bye\"\n");
        let (fm, _) = parse_frontmatter(&src).unwrap();
        assert_eq!(fm.title, "It's \"Zeta\": quoted");
        assert_eq!(fm.description, "Say \"hi\" \\ bye");
    }

    #[test]
    fn frontmatter_block_scalar_is_rejected_naming_the_key() {
        let src = source("tooling", "zeta", 1, "Zeta")
            .replace("description: About Zeta.\n", "description: >\n  folded\n");
        let err = parse_frontmatter(&src).unwrap_err();
        assert!(err.contains("`description`"), "{err}");
    }

    #[test]
    fn unknown_category_is_an_error_naming_it_and_the_file() {
        let err = DocPage::parse(Lang::En, "cooking-rice.md", &source("cooking", "rice", 1, "Rice"))
            .unwrap_err()
            .to_string();
        assert_eq!(err, "en/cooking-rice.md: unknown category `cooking`");
    }

    #[test]
    fn page_missing_its_twin_is_an_error_naming_it() {
        let mut no_id_beta = pages();
        no_id_beta.retain(|p| !(p.lang == Lang::Id && p.slug == "beta"));
        let err = Site::new(no_id_beta).unwrap_err().to_string();
        assert_eq!(err, "en/tooling-beta.md (tooling/beta) has no id twin");

        let mut no_en_zeta = pages();
        no_en_zeta.retain(|p| !(p.lang == Lang::En && p.slug == "zeta"));
        let err = Site::new(no_en_zeta).unwrap_err().to_string();
        assert_eq!(err, "id/tooling-zeta.md (tooling/zeta) has no en twin");
    }

    #[test]
    fn duplicate_page_is_an_error_naming_both_files() {
        let mut all = pages();
        let mut copy = page(Lang::En, "tooling", "zeta", 3, "Zeta Copy");
        copy.file = "tooling-zeta-copy.md".into();
        all.push(copy);
        let err = Site::new(all).unwrap_err().to_string();
        assert_eq!(
            err,
            "en: tooling-zeta.md and tooling-zeta-copy.md both define tooling/zeta"
        );
    }

    #[test]
    fn sidebar_orders_categories_then_order_then_title() {
        let site = site();
        let got: Vec<(&str, Vec<&str>)> = site
            .sidebar(Lang::En)
            .into_iter()
            .map(|(c, ps)| (c.slug(), ps.iter().map(|p| p.title.as_str()).collect()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("getting-started", vec!["Introduction", "Quick Start"]),
                ("tooling", vec!["Zeta", "Alpha", "Beta"]),
                ("integrations", vec!["Graphify"]),
            ]
        );
    }

    #[test]
    fn pager_crosses_the_category_boundary_in_one_language() {
        let site = site();
        let titles = |lang: Lang, cat: Category, slug: &str| {
            let (prev, next) = site.pager(site.find(lang, cat, slug).unwrap());
            (
                prev.map(|p| (p.lang, p.title.clone())),
                next.map(|p| (p.lang, p.title.clone())),
            )
        };
        let en = |t: &str| Some((Lang::En, t.to_string()));
        let id = |t: &str| Some((Lang::Id, t.to_string()));

        assert_eq!(titles(Lang::En, Category::GettingStarted, "introduction"), (None, en("Quick Start")));
        assert_eq!(titles(Lang::En, Category::GettingStarted, "quick-start"), (en("Introduction"), en("Zeta")));
        assert_eq!(titles(Lang::En, Category::Tooling, "beta"), (en("Alpha"), en("Graphify")));
        assert_eq!(titles(Lang::En, Category::Integrations, "graphify"), (en("Beta"), None));
        assert_eq!(titles(Lang::Id, Category::GettingStarted, "quick-start"), (id("Pengantar"), id("Zeta")));
    }
}
