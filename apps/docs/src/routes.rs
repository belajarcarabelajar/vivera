use std::error::Error;
use std::sync::OnceLock;

use maud::{Markup, html};
use maudit::content::render_markdown;
use maudit::route::prelude::*;

use crate::content::{Category, DocPage, Lang, Site};
use crate::layout::{self, AssetUrls, Link, PageView, SidebarSection};

pub const ORIGIN: &str = "https://vivera.belajarcarabelajar.com";
/// Relative to the working directory, which is apps/docs during a build.
pub const STYLESHEET: &str = "assets/site.css";
pub const SCRIPT: &str = "assets/docs.js";

pub fn docs_root(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "/docs/",
        Lang::Id => "/id/docs/",
    }
}

pub fn category_path(lang: Lang, category: Category) -> String {
    format!("{}{}/", docs_root(lang), category.slug())
}

/// The introduction entry is served at the docs root, not under its category.
fn path_in(lang: Lang, page: &DocPage) -> String {
    if page.is_intro() {
        docs_root(lang).to_string()
    } else {
        format!("{}{}/{}/", docs_root(lang), page.category.slug(), page.slug)
    }
}

pub fn page_path(page: &DocPage) -> String {
    path_in(page.lang, page)
}

fn alternate_links(en_path: &str, id_path: &str) -> Vec<(&'static str, String)> {
    vec![
        ("en", format!("{ORIGIN}{en_path}")),
        ("id", format!("{ORIGIN}{id_path}")),
        ("x-default", format!("{ORIGIN}{en_path}")),
    ]
}

pub fn page_alternates(page: &DocPage) -> Vec<(&'static str, String)> {
    alternate_links(&path_in(Lang::En, page), &path_in(Lang::Id, page))
}

pub fn route_list(site: &Site) -> Vec<String> {
    let mut out = Vec::new();
    for lang in Lang::ALL {
        out.push(docs_root(lang).to_string());
        for (category, pages) in site.sidebar(lang) {
            out.push(category_path(lang, category));
            out.extend(pages.into_iter().filter(|p| !p.is_intro()).map(page_path));
        }
    }
    out
}

fn page_link(page: &DocPage) -> Link {
    Link {
        href: page_path(page),
        title: page.title.clone(),
    }
}

fn sidebar_sections(site: &Site, lang: Lang) -> Vec<SidebarSection> {
    site.sidebar(lang)
        .into_iter()
        .map(|(category, pages)| SidebarSection {
            label: category.label(lang),
            links: pages.into_iter().map(page_link).collect(),
        })
        .collect()
}

pub fn page_markup(site: &Site, page: &DocPage, assets: &AssetUrls) -> Markup {
    let lang = page.lang;
    let body_html = render_markdown(&page.body, None, None, None);
    let mut article = layout::doc_article(&page.title, &body_html);
    if page.is_intro() {
        article = html! {
            (article)
            h2 { (layout::ui(lang).categories) }
            ul {
                @for category in site.categories(lang) {
                    li { a href=(category_path(lang, category)) { (category.label(lang)) } }
                }
            }
        };
    }
    let (prev, next) = site.pager(page);
    let path = page_path(page);
    layout::render(&PageView {
        lang,
        title: &page.title,
        description: &page.description,
        canonical: format!("{ORIGIN}{path}"),
        alternates: page_alternates(page),
        twin_path: path_in(lang.other(), page),
        sidebar: sidebar_sections(site, lang),
        current_path: Some(path),
        article,
        pagefind: true,
        prev: prev.map(page_link),
        next: next.map(page_link),
        assets,
    })
}

pub fn category_markup(
    site: &Site,
    lang: Lang,
    category: Category,
    assets: &AssetUrls,
) -> Option<Markup> {
    let (_, pages) = site.sidebar(lang).into_iter().find(|(c, _)| *c == category)?;
    let categories = site.categories(lang);
    let index = categories.iter().position(|c| *c == category)?;
    let category_link = |c: Category| Link {
        href: category_path(lang, c),
        title: c.label(lang).to_string(),
    };
    let label = category.label(lang);
    let description = layout::category_description(lang, label);
    let path = category_path(lang, category);
    let article = html! {
        h1 { (label) }
        ul {
            @for page in &pages {
                li {
                    a href=(page_path(page)) { (page.title) }
                    p { (page.description) }
                }
            }
        }
    };
    Some(layout::render(&PageView {
        lang,
        title: label,
        description: &description,
        canonical: format!("{ORIGIN}{path}"),
        alternates: alternate_links(
            &category_path(Lang::En, category),
            &category_path(Lang::Id, category),
        ),
        twin_path: category_path(lang.other(), category),
        sidebar: sidebar_sections(site, lang),
        current_path: None,
        article,
        pagefind: false,
        prev: index.checked_sub(1).map(|i| category_link(categories[i])),
        next: categories.get(index + 1).map(|c| category_link(*c)),
        assets,
    }))
}

static SITE: OnceLock<Site> = OnceLock::new();

pub fn install(site: Site) {
    SITE.set(site).expect("site content is installed once");
}

fn site() -> Result<&'static Site, Box<dyn Error>> {
    SITE.get().ok_or_else(|| "site content was not installed".into())
}

fn asset_urls(ctx: &mut PageContext) -> Result<AssetUrls, Box<dyn Error>> {
    let style = ctx.assets.add_style(STYLESHEET)?;
    let script = ctx.assets.add_script(SCRIPT)?;
    Ok(AssetUrls {
        stylesheet: style.url().to_string(),
        script: script.url().to_string(),
    })
}

#[derive(Params, Clone)]
pub struct CategoryParams {
    pub category: String,
}

#[derive(Params, Clone)]
pub struct DocParams {
    pub category: String,
    pub slug: String,
}

fn render_root(ctx: &mut PageContext, lang: Lang) -> Result<Markup, Box<dyn Error>> {
    let site = site()?;
    let page = site
        .find(lang, Category::GettingStarted, "introduction")
        .ok_or_else(|| format!("no getting-started/introduction page for {lang}"))?;
    let assets = asset_urls(ctx)?;
    Ok(page_markup(site, page, &assets))
}

fn render_category(ctx: &mut PageContext, lang: Lang) -> Result<Markup, Box<dyn Error>> {
    let params = ctx.params::<CategoryParams>();
    let category = Category::from_slug(&params.category)
        .ok_or_else(|| format!("unknown category {}", params.category))?;
    let site = site()?;
    let assets = asset_urls(ctx)?;
    Ok(category_markup(site, lang, category, &assets)
        .ok_or_else(|| format!("category {} has no {lang} pages", params.category))?)
}

fn render_doc(ctx: &mut PageContext, lang: Lang) -> Result<Markup, Box<dyn Error>> {
    let params = ctx.params::<DocParams>();
    let category = Category::from_slug(&params.category)
        .ok_or_else(|| format!("unknown category {}", params.category))?;
    let site = site()?;
    let page = site
        .find(lang, category, &params.slug)
        .ok_or_else(|| format!("no {lang} page {}/{}", params.category, params.slug))?;
    let assets = asset_urls(ctx)?;
    Ok(page_markup(site, page, &assets))
}

fn category_pages(lang: Lang) -> Pages<CategoryParams> {
    SITE.get()
        .map(|site| {
            site.categories(lang)
                .into_iter()
                .map(|c| {
                    Page::from_params(CategoryParams {
                        category: c.slug().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn doc_pages(lang: Lang) -> Pages<DocParams> {
    SITE.get()
        .map(|site| {
            site.reading_order(lang)
                .into_iter()
                .filter(|p| !p.is_intro())
                .map(|p| {
                    Page::from_params(DocParams {
                        category: p.category.slug().to_string(),
                        slug: p.slug.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[route("/docs/")]
pub struct DocsRootEn;

impl Route for DocsRootEn {
    fn render(&self, ctx: &mut PageContext) -> impl Into<RenderResult> {
        render_root(ctx, Lang::En)
    }
}

#[route("/id/docs/")]
pub struct DocsRootId;

impl Route for DocsRootId {
    fn render(&self, ctx: &mut PageContext) -> impl Into<RenderResult> {
        render_root(ctx, Lang::Id)
    }
}

#[route("/docs/[category]/")]
pub struct CategoryEn;

impl Route<CategoryParams> for CategoryEn {
    fn pages(&self, _ctx: &mut DynamicRouteContext) -> Pages<CategoryParams> {
        category_pages(Lang::En)
    }

    fn render(&self, ctx: &mut PageContext) -> impl Into<RenderResult> {
        render_category(ctx, Lang::En)
    }
}

#[route("/id/docs/[category]/")]
pub struct CategoryId;

impl Route<CategoryParams> for CategoryId {
    fn pages(&self, _ctx: &mut DynamicRouteContext) -> Pages<CategoryParams> {
        category_pages(Lang::Id)
    }

    fn render(&self, ctx: &mut PageContext) -> impl Into<RenderResult> {
        render_category(ctx, Lang::Id)
    }
}

#[route("/docs/[category]/[slug]/")]
pub struct DocEn;

impl Route<DocParams> for DocEn {
    fn pages(&self, _ctx: &mut DynamicRouteContext) -> Pages<DocParams> {
        doc_pages(Lang::En)
    }

    fn render(&self, ctx: &mut PageContext) -> impl Into<RenderResult> {
        render_doc(ctx, Lang::En)
    }
}

#[route("/id/docs/[category]/[slug]/")]
pub struct DocId;

impl Route<DocParams> for DocId {
    fn pages(&self, _ctx: &mut DynamicRouteContext) -> Pages<DocParams> {
        doc_pages(Lang::Id)
    }

    fn render(&self, ctx: &mut PageContext) -> impl Into<RenderResult> {
        render_doc(ctx, Lang::Id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::fixtures::site;

    fn assets() -> AssetUrls {
        AssetUrls {
            stylesheet: "/_maudit/site-abc.css".into(),
            script: "/_maudit/docs-def.js".into(),
        }
    }

    fn assert_contains_all(html: &str, needles: &[&str]) {
        for needle in needles {
            assert!(html.contains(needle), "missing {needle}\n{html}");
        }
    }

    #[test]
    fn route_list_covers_both_languages_in_reading_order() {
        let mut want = Vec::new();
        for root in ["/docs/", "/id/docs/"] {
            for rest in [
                "",
                "getting-started/",
                "getting-started/quick-start/",
                "tooling/",
                "tooling/zeta/",
                "tooling/alpha/",
                "tooling/beta/",
                "integrations/",
                "integrations/graphify/",
            ] {
                want.push(format!("{root}{rest}"));
            }
        }
        assert_eq!(route_list(&site()), want);
    }

    #[test]
    fn hreflang_links_match_for_a_page_and_its_twin() {
        let site = site();
        let o = "https://vivera.belajarcarabelajar.com";
        for (category, slug, en_path, id_path) in [
            (Category::Tooling, "zeta", "/docs/tooling/zeta/", "/id/docs/tooling/zeta/"),
            (Category::GettingStarted, "introduction", "/docs/", "/id/docs/"),
        ] {
            let want = vec![
                ("en", format!("{o}{en_path}")),
                ("id", format!("{o}{id_path}")),
                ("x-default", format!("{o}{en_path}")),
            ];
            let en = site.find(Lang::En, category, slug).unwrap();
            let id = site.twin(en).unwrap();
            assert_eq!(id.lang, Lang::Id);
            assert_eq!(page_alternates(en), want);
            assert_eq!(page_alternates(id), want);
        }
    }

    #[test]
    fn en_page_markup_carries_the_head_header_and_landmark_contract() {
        let site = site();
        let page = site.find(Lang::En, Category::Tooling, "zeta").unwrap();
        let html = page_markup(&site, page, &assets()).into_string();
        assert_contains_all(
            &html,
            &[
                "<!DOCTYPE html><html lang=\"en\">",
                "<title>Zeta | Vivera Docs</title>",
                "<meta name=\"description\" content=\"About Zeta.\">",
                "<link rel=\"canonical\" href=\"https://vivera.belajarcarabelajar.com/docs/tooling/zeta/\">",
                "<link rel=\"alternate\" hreflang=\"en\" href=\"https://vivera.belajarcarabelajar.com/docs/tooling/zeta/\">",
                "<link rel=\"alternate\" hreflang=\"id\" href=\"https://vivera.belajarcarabelajar.com/id/docs/tooling/zeta/\">",
                "<link rel=\"alternate\" hreflang=\"x-default\" href=\"https://vivera.belajarcarabelajar.com/docs/tooling/zeta/\">",
                "<link rel=\"stylesheet\" href=\"/_maudit/site-abc.css\">",
                "<script src=\"/_maudit/docs-def.js\" defer></script>",
                "<header class=\"site-header\"><a class=\"brand\" href=\"https://vivera.belajarcarabelajar.com/\">Vivera</a>",
                "<nav class=\"site-nav\" aria-label=\"Site\"><a href=\"/workshop/\">Workshop</a><a href=\"https://github.com/belajarcarabelajar/vivera\">GitHub</a></nav>",
                "<a class=\"lang-switch\" href=\"/id/docs/tooling/zeta/\" hreflang=\"id\" lang=\"id\">Bahasa Indonesia</a>",
                "<button class=\"search-toggle\" type=\"button\" aria-controls=\"search\" aria-expanded=\"false\">Search</button>",
                "<button class=\"sidebar-toggle\" type=\"button\" aria-controls=\"sidebar\" aria-expanded=\"false\">Menu</button></header>",
                "<div id=\"search\" class=\"search-panel\" hidden></div>",
                "<div class=\"layout\"><nav id=\"sidebar\" class=\"sidebar\" aria-label=\"Documentation\"><h2 class=\"sidebar-category\">Getting started</h2><ul><li><a href=\"/docs/\">Introduction</a></li>",
                "<h2 class=\"sidebar-category\">Tooling</h2><ul><li><a href=\"/docs/tooling/zeta/\" aria-current=\"page\">Zeta</a></li>",
                "<main id=\"content\"><article class=\"doc\" data-pagefind-body>",
                "Body of Zeta.",
                "<a class=\"pager-prev\" href=\"/docs/getting-started/quick-start/\" rel=\"prev\">Quick Start</a>",
                "<a class=\"pager-next\" href=\"/docs/tooling/alpha/\" rel=\"next\">Alpha</a>",
                "<footer class=\"site-footer\">",
                "href=\"mailto:vivera@belajarcarabelajar.com\"",
                "href=\"https://github.com/belajarcarabelajar/vivera/blob/main/LICENSE\"",
            ],
        );
        assert_eq!(html.matches("aria-current").count(), 1, "{html}");
        assert!(!html.contains("style="), "{html}");
    }

    #[test]
    fn id_page_markup_switches_to_english_and_stays_in_indonesian() {
        let site = site();
        let page = site.find(Lang::Id, Category::GettingStarted, "quick-start").unwrap();
        let html = page_markup(&site, page, &assets()).into_string();
        assert_contains_all(
            &html,
            &[
                "<html lang=\"id\">",
                "<title>Mulai Cepat | Dokumentasi Vivera</title>",
                "<link rel=\"canonical\" href=\"https://vivera.belajarcarabelajar.com/id/docs/getting-started/quick-start/\">",
                "<a class=\"brand\" href=\"https://vivera.belajarcarabelajar.com/id/\">Vivera</a>",
                "<a href=\"/id/workshop/\">Workshop</a>",
                "<a class=\"lang-switch\" href=\"/docs/getting-started/quick-start/\" hreflang=\"en\" lang=\"en\">English</a>",
                "aria-expanded=\"false\">Cari</button>",
                "<nav id=\"sidebar\" class=\"sidebar\" aria-label=\"Dokumentasi\">",
                "<h2 class=\"sidebar-category\">Memulai</h2>",
                "<h2 class=\"sidebar-category\">Perkakas</h2>",
                "<h2 class=\"sidebar-category\">Integrasi</h2>",
                "<a class=\"pager-prev\" href=\"/id/docs/\" rel=\"prev\">Pengantar</a>",
                "<a class=\"pager-next\" href=\"/id/docs/tooling/zeta/\" rel=\"next\">Zeta</a>",
            ],
        );
    }

    #[test]
    fn docs_root_renders_the_introduction_with_links_to_every_category() {
        let site = site();
        let page = site.find(Lang::En, Category::GettingStarted, "introduction").unwrap();
        let html = page_markup(&site, page, &assets()).into_string();
        assert_contains_all(
            &html,
            &[
                "<link rel=\"canonical\" href=\"https://vivera.belajarcarabelajar.com/docs/\">",
                "<a class=\"lang-switch\" href=\"/id/docs/\" hreflang=\"id\" lang=\"id\">Bahasa Indonesia</a>",
                "<a href=\"/docs/\" aria-current=\"page\">Introduction</a>",
                "Body of Introduction.",
                "<h2>Categories</h2><ul><li><a href=\"/docs/getting-started/\">Getting started</a></li><li><a href=\"/docs/tooling/\">Tooling</a></li><li><a href=\"/docs/integrations/\">Integrations</a></li></ul></article>",
                "<a class=\"pager-next\" href=\"/docs/getting-started/quick-start/\" rel=\"next\">Quick Start</a>",
            ],
        );
        assert!(!html.contains("pager-prev"), "{html}");
    }

    #[test]
    fn category_page_lists_its_pages_in_order_and_links_neighbour_categories() {
        let site = site();
        let html = category_markup(&site, Lang::En, Category::Tooling, &assets())
            .unwrap()
            .into_string();
        assert_contains_all(
            &html,
            &[
                "<title>Tooling | Vivera Docs</title>",
                "<meta name=\"description\" content=\"Tooling pages of the Vivera documentation.\">",
                "<link rel=\"canonical\" href=\"https://vivera.belajarcarabelajar.com/docs/tooling/\">",
                "<link rel=\"alternate\" hreflang=\"id\" href=\"https://vivera.belajarcarabelajar.com/id/docs/tooling/\">",
                "<a class=\"lang-switch\" href=\"/id/docs/tooling/\" hreflang=\"id\" lang=\"id\">Bahasa Indonesia</a>",
                "<article class=\"doc\"><h1>Tooling</h1><ul><li><a href=\"/docs/tooling/zeta/\">Zeta</a><p>About Zeta.</p></li><li><a href=\"/docs/tooling/alpha/\">Alpha</a><p>About Alpha.</p></li><li><a href=\"/docs/tooling/beta/\">Beta</a><p>About Beta.</p></li></ul></article>",
                "<a class=\"pager-prev\" href=\"/docs/getting-started/\" rel=\"prev\">Getting started</a>",
                "<a class=\"pager-next\" href=\"/docs/integrations/\" rel=\"next\">Integrations</a>",
            ],
        );
        assert!(!html.contains("aria-current"), "{html}");
        assert!(category_markup(&site, Lang::En, Category::Pipeline, &assets()).is_none());
    }
}
