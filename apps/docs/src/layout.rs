use maud::{DOCTYPE, Markup, PreEscaped, html};

use crate::content::Lang;

#[derive(Debug, Clone, PartialEq)]
pub struct AssetUrls {
    pub stylesheet: String,
    pub script: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub href: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SidebarSection {
    pub label: &'static str,
    pub links: Vec<Link>,
}

pub struct PageView<'a> {
    pub lang: Lang,
    pub title: &'a str,
    pub description: &'a str,
    pub canonical: String,
    pub alternates: Vec<(&'static str, String)>,
    pub twin_path: String,
    pub sidebar: Vec<SidebarSection>,
    pub current_path: Option<String>,
    pub article: Markup,
    pub pagefind: bool,
    pub prev: Option<Link>,
    pub next: Option<Link>,
    pub assets: &'a AssetUrls,
}

/// Interface copy per language.
pub struct Ui {
    pub title_suffix: &'static str,
    pub brand_href: &'static str,
    pub workshop_href: &'static str,
    pub switch_label: &'static str,
    pub search: &'static str,
    pub menu: &'static str,
    pub site_nav_label: &'static str,
    pub sidebar_label: &'static str,
    pub pager_label: &'static str,
    pub contact: &'static str,
    pub license: &'static str,
    pub categories: &'static str,
}

pub fn ui(lang: Lang) -> Ui {
    match lang {
        Lang::En => Ui {
            title_suffix: "Vivera Docs",
            brand_href: "https://vivera.belajarcarabelajar.com/",
            workshop_href: "/workshop/",
            switch_label: "Bahasa Indonesia",
            search: "Search",
            menu: "Menu",
            site_nav_label: "Site",
            sidebar_label: "Documentation",
            pager_label: "Previous and next page",
            contact: "Contact",
            license: "MIT License",
            categories: "Categories",
        },
        Lang::Id => Ui {
            title_suffix: "Dokumentasi Vivera",
            brand_href: "https://vivera.belajarcarabelajar.com/id/",
            workshop_href: "/id/workshop/",
            switch_label: "English",
            search: "Cari",
            menu: "Menu",
            site_nav_label: "Situs",
            sidebar_label: "Dokumentasi",
            pager_label: "Halaman sebelumnya dan berikutnya",
            contact: "Kontak",
            license: "Lisensi MIT",
            categories: "Kategori",
        },
    }
}

pub fn category_description(lang: Lang, label: &str) -> String {
    match lang {
        Lang::En => format!("{label} pages of the Vivera documentation."),
        Lang::Id => format!("Halaman {label} dalam dokumentasi Vivera."),
    }
}

pub fn render(view: &PageView) -> Markup {
    let ui = ui(view.lang);
    let other = view.lang.other().code();
    let current = view.current_path.as_deref();
    html! {
        (DOCTYPE)
        html lang=(view.lang.code()) {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                title { (view.title) " | " (ui.title_suffix) }
                meta name="description" content=(view.description);
                link rel="canonical" href=(view.canonical);
                @for (hreflang, href) in &view.alternates {
                    link rel="alternate" hreflang=(hreflang) href=(href);
                }
                link rel="stylesheet" href=(view.assets.stylesheet);
                script src=(view.assets.script) defer {}
            }
            body {
                header class="site-header" {
                    a class="brand" href=(ui.brand_href) { "Vivera" }
                    nav class="site-nav" aria-label=(ui.site_nav_label) {
                        a href=(ui.workshop_href) { "Workshop" }
                        a href="https://github.com/belajarcarabelajar/vivera" { "GitHub" }
                    }
                    a class="lang-switch" href=(view.twin_path) hreflang=(other) lang=(other) { (ui.switch_label) }
                    button class="search-toggle" type="button" aria-controls="search" aria-expanded="false" { (ui.search) }
                    button class="sidebar-toggle" type="button" aria-controls="sidebar" aria-expanded="false" { (ui.menu) }
                }
                div id="search" class="search-panel" hidden {}
                div class="layout" {
                    nav id="sidebar" class="sidebar" aria-label=(ui.sidebar_label) {
                        @for section in &view.sidebar {
                            h2 class="sidebar-category" { (section.label) }
                            ul {
                                @for link in &section.links {
                                    li {
                                        a href=(link.href) aria-current=[(current == Some(link.href.as_str())).then_some("page")] { (link.title) }
                                    }
                                }
                            }
                        }
                    }
                    main id="content" {
                        article class="doc" data-pagefind-body[view.pagefind] { (view.article) }
                        nav class="pager" aria-label=(ui.pager_label) {
                            @if let Some(prev) = &view.prev {
                                a class="pager-prev" href=(prev.href) rel="prev" { (prev.title) }
                            }
                            @if let Some(next) = &view.next {
                                a class="pager-next" href=(next.href) rel="next" { (next.title) }
                            }
                        }
                    }
                }
                footer class="site-footer" {
                    p {
                        (ui.contact) ": "
                        a href="mailto:vivera@belajarcarabelajar.com" { "vivera@belajarcarabelajar.com" }
                    }
                    p {
                        a href="https://github.com/belajarcarabelajar/vivera/blob/main/LICENSE" { (ui.license) }
                    }
                }
            }
        }
    }
}

/// The introduction body has no level-one heading, so the title stands in for it.
pub fn doc_article(title: &str, body_html: &str) -> Markup {
    html! {
        @if !body_html.contains("<h1") {
            h1 { (title) }
        }
        (PreEscaped(body_html))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_article_adds_the_title_heading_only_when_the_body_has_none() {
        assert_eq!(
            doc_article("Intro & more", "<p>x</p>").into_string(),
            "<h1>Intro &amp; more</h1><p>x</p>"
        );
        assert_eq!(
            doc_article("Zeta", "<h1 id=\"zeta\">Zeta</h1><p>x</p>").into_string(),
            "<h1 id=\"zeta\">Zeta</h1><p>x</p>"
        );
    }
}
