"""
update_about.py
Rewrites about.html with all change-log edits applied.

USAGE
-----
1. Save this file in your repo folder (same folder as about.html).
2. In a terminal in that folder, run:    python update_about.py
3. Commit the modified about.html in GitHub Desktop and push.

Tested with Python 3.x — no third-party libraries required.
"""
from pathlib import Path

TARGET_FILENAME = "about.html"

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>About | Landslides in Western North Carolina</title>
  <meta name="description" content="About the landslide hazard mapping program in Western North Carolina, project credits, organizational information, and legal disclaimer." />

  <link rel="icon" type="image/png" href="assets/images/shared/ncgs-seal.png" />
  <link rel="apple-touch-icon" href="assets/images/shared/ncgs-seal.png" />

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />

  <style>
    :root{--clr-bg:#122518;--clr-primary:#C04C00;--clr-accent:#3E8452;--clr-text:#FFFFFF;--clr-text-muted:#D4E8D8;--clr-surface:#1C3521;--clr-surface-2:#243D29;--clr-border:#2E5438;--clr-focus:#FFD166;--font-main:'Source Sans 3','Source Sans Pro',Arial,sans-serif;}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html{scroll-behavior:smooth;}
    body{background:var(--clr-bg);color:var(--clr-text);font-family:var(--font-main);font-size:1rem;line-height:1.6;min-height:100vh;display:flex;flex-direction:column;}
    .skip-nav{position:absolute;top:-100%;left:0;background:var(--clr-focus);color:#000;font-weight:700;padding:0.75rem 1.5rem;z-index:9999;text-decoration:none;border-radius:0 0 4px 0;transition:top 0.2s;}
    .skip-nav:focus{top:0;}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
    :focus-visible{outline:3px solid var(--clr-focus);outline-offset:3px;}
    :focus:not(:focus-visible){outline:none;}

    .site-header{background:var(--clr-bg);padding:1.25rem 2rem;display:flex;align-items:center;gap:1.25rem;border-bottom:3px solid var(--clr-accent);flex-shrink:0;}
    .site-header__logo{width:80px;height:80px;flex-shrink:0;border-radius:50%;overflow:hidden;border:2px solid var(--clr-accent);}
    .site-header__logo img{width:100%;height:100%;object-fit:contain;}
    .site-header__text h1{font-size:clamp(1.3rem,3vw,2rem);font-weight:700;color:var(--clr-text);line-height:1.2;}
    .site-header__text p{font-size:clamp(0.85rem,1.4vw,0.95rem);color:var(--clr-text-muted);max-width:65ch;margin-top:0.3rem;}

    .site-nav{background:var(--clr-surface);border-bottom:1px solid var(--clr-border);position:sticky;top:0;z-index:100;flex-shrink:0;}
    .site-nav__list{list-style:none;display:flex;flex-wrap:wrap;padding:0 1rem;max-width:1200px;margin:0 auto;}
    .site-nav__item a{display:block;padding:1rem 1.5rem;color:var(--clr-text-muted);text-decoration:none;font-weight:700;font-size:0.95rem;border-bottom:3px solid transparent;transition:color 0.2s,border-color 0.2s;white-space:nowrap;}
    .site-nav__item a:hover{color:var(--clr-text);border-bottom-color:var(--clr-accent);}
    .site-nav__item a[aria-current="page"]{color:var(--clr-text);border-bottom-color:var(--clr-primary);}

    .page-wrapper{max-width:1200px;margin:0 auto;padding:2rem 1.5rem 4rem;flex:1;}
    .section-heading{font-size:1.6rem;font-weight:700;color:var(--clr-text);margin-bottom:1rem;padding-bottom:0.5rem;border-bottom:2px solid var(--clr-border);}
    .section-divider{border:none;border-top:1px solid var(--clr-border);margin:2.5rem 0;}

    .about-block{display:grid;grid-template-columns:280px 1fr;gap:2rem;align-items:start;}
    .about-block__photo{border-radius:6px;overflow:hidden;border:2px solid var(--clr-border);flex-shrink:0;}
    .about-block__photo img{width:100%;display:block;object-fit:cover;aspect-ratio:3/4;}
    .about-block__text p{color:var(--clr-text-muted);font-size:0.975rem;line-height:1.7;margin-bottom:1rem;}
    .about-block__text p:last-child{margin-bottom:0;}
    .about-block__text a{color:var(--clr-text-muted);text-decoration:underline;}
    .about-block__text a:hover{color:var(--clr-text);}

    .disclaimer-box{background:var(--clr-surface);border:1px solid var(--clr-border);border-top:4px solid var(--clr-primary);border-radius:0 0 6px 6px;padding:1.5rem 1.75rem;}
    .disclaimer-box__warning{font-weight:700;font-size:0.85rem;color:var(--clr-text);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:1rem;padding:0.6rem 0.9rem;background:rgba(192,76,0,0.2);border-left:3px solid var(--clr-primary);border-radius:0 3px 3px 0;}
    .disclaimer-box p{color:var(--clr-text-muted);font-size:0.9rem;line-height:1.7;margin-bottom:0.75rem;}
    .disclaimer-box p:last-child{margin-bottom:0;}

    .credits-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-top:1.25rem;}
    .credit-card{background:var(--clr-surface);border:1px solid var(--clr-border);border-left:4px solid var(--clr-accent);border-radius:0 6px 6px 0;padding:1.25rem 1.5rem;}
    .credit-card__title{font-weight:700;font-size:1rem;color:var(--clr-text);margin-bottom:0.6rem;}
    .credit-card__members{font-size:0.875rem;color:var(--clr-text-muted);line-height:1.65;}

    .org-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:1.25rem;}
    .org-card{background:var(--clr-surface);border:1px solid var(--clr-border);border-radius:6px;overflow:hidden;}
    .org-card__img{width:100%;height:180px;overflow:hidden;}
    .org-card__img img{width:100%;height:100%;object-fit:cover;object-position:center 30%;}
    .org-card__body{padding:1.25rem 1.5rem;}
    .org-card__name{font-size:1.05rem;font-weight:700;color:var(--clr-text);margin-bottom:0.6rem;}
    .org-card__name a{color:inherit;text-decoration:underline;}
    .org-card__name a:hover{color:var(--clr-accent);}
    .org-card__desc{font-size:0.9rem;color:var(--clr-text-muted);line-height:1.65;margin-bottom:0.9rem;}
    .org-card__contact{display:inline-flex;align-items:center;gap:0.4rem;font-size:0.875rem;font-weight:700;color:var(--clr-text-muted);text-decoration:none;padding:0.4rem 0.9rem;border:1px solid var(--clr-border);border-radius:4px;transition:border-color 0.2s,color 0.2s,background 0.2s;}
    .org-card__contact:hover,.org-card__contact:focus-visible{border-color:var(--clr-accent);color:var(--clr-text);background:var(--clr-surface-2);}

    .site-footer{background:var(--clr-surface);border-top:3px solid var(--clr-primary);padding:1.75rem 2rem;flex-shrink:0;}
    .site-footer__inner{max-width:1200px;margin:0 auto;}
    .site-footer__org{font-size:1rem;font-weight:700;color:var(--clr-accent);}
    .site-footer__detail{font-size:0.9rem;color:var(--clr-text-muted);margin-top:0.25rem;}
    .site-footer__detail a{color:var(--clr-text-muted);text-decoration:underline;}
    .site-footer__detail a:hover{color:var(--clr-text);}

    @media(max-width:768px){
      .about-block{grid-template-columns:1fr;}
      .about-block__photo img{aspect-ratio:16/9;}
      .credits-grid,.org-grid{grid-template-columns:1fr;}
      .site-header{padding:1rem;}
      .site-header__logo{width:60px;height:60px;}
      .page-wrapper{padding:1.25rem 1rem 3rem;}
    }
  </style>
</head>
<body>
  <a class="skip-nav" href="#main-content">Skip to main content</a>

  <header class="site-header" role="banner">
    <div class="site-header__logo">
      <a href="index.html" aria-label="Return to home page">
        <img src="assets/images/shared/ncgs-seal.png" alt="North Carolina Geological Survey seal" />
      </a>
    </div>
    <div class="site-header__text">
      <h1>Landslides in Western North Carolina</h1>
      <p>Explore current and historical information about landslides across the region, and access resources to help you plan for and build resilience to landslide hazards.</p>
    </div>
  </header>

  <nav class="site-nav" aria-label="Main navigation">
    <ul class="site-nav__list" role="list">
      <li class="site-nav__item"><a href="index.html">Home</a></li>
      <li class="site-nav__item"><a href="data-tour.html">Data Tour Guide</a></li>
      <li class="site-nav__item"><a href="learn-more.html">Learn More</a></li>
      <li class="site-nav__item"><a href="downloads.html">Downloads</a></li>
      <li class="site-nav__item"><a href="about.html" aria-current="page">About</a></li>
    </ul>
  </nav>

  <main id="main-content" class="page-wrapper">

    <section aria-labelledby="heading-about">
      <h2 class="section-heading" id="heading-about">About the Project</h2>
      <div class="about-block">
        <div class="about-block__photo">
          <img src="assets/images/main-site/about-mountain-landscape.jpg"
            alt="Mountain landscape in Western North Carolina showing forested ridgelines"
            loading="lazy" />
        </div>
        <div class="about-block__text">
          <p>The Hurricane Recovery Act of 2005 (Section 6) directs the North Carolina Department of Environmental Quality (NCDEQ) to ensure that maps indicating areas vulnerable to landslides be made available for the 19 counties designated in the Major Disaster Declarations for Hurricanes Frances and Ivan.</p>
          <p>To that end, the NCDEQ and the <a href="https://deq.nc.gov/about/divisions/energy-mineral-land-resources/north-carolina-geological-survey" target="_blank" rel="noopener noreferrer" aria-label="North Carolina Geological Survey — opens in a new tab">North Carolina Geological Survey (NCGS)</a> have partnered with UNC Asheville's National Environmental Mapping and Applications Center (NEMAC) to support the data delivery and visualization of accurate, useful, and current landslide hazard data through a variety of web products. NEMAC is working with NCGS to make it easier for various audiences to access, interact with, and understand landslide hazard data.</p>
          <p>All electronic and/or hard copy products (maps, data, text, etc.) produced by this landslide hazard mapping program are considered public information and may be freely redistributed and/or copied. These products, however, are intended to serve for general planning purposes only and are provided on an "as is" basis. These maps and products do not substitute for an on-the-ground site assessment by qualified individuals.</p>
        </div>
      </div>
    </section>

    <hr class="section-divider" />

    <section aria-labelledby="heading-disclaimer">
      <h2 class="section-heading" id="heading-disclaimer">Disclaimer</h2>
      <div class="disclaimer-box" role="note" aria-label="Legal disclaimer">
        <div class="disclaimer-box__warning">Entrance into this website and use of these materials constitutes acceptance of this disclaimer of liability.</div>
        <p>Therefore, users must be aware of data conditions and bear responsibility for the appropriate use of the information with respect to possible errors, original map scale, collection methodology, currency of data, and other conditions specific to current data.</p>
        <p>In no event shall NCDEQ or its employees be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, injuries or death; procurement or substitute goods or services; loss of use, data or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of these data, even if advised of the possibility of such damage.</p>
        <p>This website is being provided for the benefit of the general public. No representation is made that this website will meet the specific requirements of any person or will operate without error or interruption. All other conditions or warranties, express or implied, are disclaimed. It is the sole responsibility of the user to evaluate the accuracy, completeness, or usefulness of any information, opinion, advice or other content available through this website. DEQ may modify or remove map services, data and access methods at will.</p>
      </div>
    </section>

    <hr class="section-divider" />

    <section aria-labelledby="heading-credits">
      <h2 class="section-heading" id="heading-credits">Credits</h2>
      <div class="credits-grid">
        <div class="credit-card">
          <div class="credit-card__title">NCDEQ / NCGS Team</div>
          <div class="credit-card__members">David Korte, Nick Bozdog<br><span style="font-size:0.9em;opacity:0.75;">Rick Wooten, Corey Scheip, Jesse Hill, Tommy Douglas</span></div>
        </div>
        <div class="credit-card">
          <div class="credit-card__title">NEMAC Team</div>
          <div class="credit-card__members">Karin Rogers, Greg Dobson, Ian Johnson, Dave Michelson, Grace Chien, Jeff Bliss<br><span style="font-size:0.9em;opacity:0.75;">Jim Fox, Nina Hall, Matthew Geiger, Mary Spivey, Katie Caruso (student intern), Kelsey Hall (student intern), Josh Ward (student intern)</span></div>
        </div>
      </div>
    </section>

    <hr class="section-divider" />

    <section aria-labelledby="heading-org">
      <h2 class="section-heading" id="heading-org">Organizational Information</h2>
      <div class="org-grid">

        <div class="org-card">
          <div class="org-card__img">
            <img src="assets/images/main-site/about-mountain-landscape.jpg"
              alt="North Carolina mountain landscape — NCGS survey area" loading="lazy" />
          </div>
          <div class="org-card__body">
            <div class="org-card__name">
              <a href="https://deq.nc.gov/about/divisions/energy-mineral-land-resources/north-carolina-geological-survey"
                target="_blank" rel="noopener noreferrer"
                aria-label="North Carolina Geological Survey website — opens in a new tab">
                North Carolina Geological Survey
              </a>
            </div>
            <div class="org-card__desc">The mission of the North Carolina Geological Survey is to provide unbiased and technically accurate applied earth science information to address societal needs. This includes geologic maps, mineral resource and geochemical information, topographic maps and digital products, and earth science education initiatives.</div>
            <a class="org-card__contact"
              href="https://deq.nc.gov/about/divisions/energy-mineral-land-resources/north-carolina-geological-survey/contact-us#Geological_Survey_-_Asheville"
              target="_blank" rel="noopener noreferrer"
              aria-label="Contact NCGS Asheville office — opens in a new tab">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false"><path d="M1.5 3h11v8.5H1.5V3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M1.5 3l5.5 5 5.5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
              Questions? Contact us
            </a>
          </div>
        </div>

        <div class="org-card">
          <div class="org-card__img">
            <img src="assets/images/main-site/about-mountain-overlook.jpg"
              alt="Person standing at a mountain overlook in Western North Carolina"
              loading="lazy"
              onerror="this.src='assets/images/main-site/about-surveyors-debris-flow.jpg'" />
          </div>
          <div class="org-card__body">
            <div class="org-card__name">
              <a href="http://nemac.unca.edu/" target="_blank" rel="noopener noreferrer"
                aria-label="UNC Asheville NEMAC website — opens in a new tab">
                National Environmental Mapping and Applications Center
              </a>
            </div>
            <div class="org-card__desc">UNC Asheville's National Environmental Mapping and Applications Center is an applied research center helping people make informed decisions in a complex and changing world. Located in the heart of the Blue Ridge Mountains, NEMAC connects federal data with real-world research, focusing on science communication, geospatial analysis, and the development of resilience plans, software tools, and data visualizations.</div>
            <a class="org-card__contact"
              href="mailto:nemac@unca.edu"
              aria-label="Email NEMAC at nemac@unca.edu">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false"><path d="M1.5 3h11v8.5H1.5V3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M1.5 3l5.5 5 5.5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
              Contact us
            </a>
          </div>
        </div>

      </div>
    </section>

  </main>

  <footer class="site-footer" role="contentinfo">
    <div class="site-footer__inner">
      <div class="site-footer__org">
        <a href="https://deq.nc.gov/about/divisions/energy-mineral-land-resources/north-carolina-geological-survey"
          target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;"
          aria-label="North Carolina Geological Survey — opens in a new tab">North Carolina Geological Survey</a>
      </div>
      <div class="site-footer__detail">Asheville Regional Office</div>
      <div class="site-footer__detail"><a href="tel:+18282964500">828-296-4500</a></div>
    </div>
  </footer>
</body>
</html>
"""

def main():
    out_path = Path(__file__).resolve().parent / TARGET_FILENAME
    out_path.write_text(HTML, encoding="utf-8", newline="\n")
    print(f"[OK] Wrote {out_path} ({len(HTML):,} bytes)")

if __name__ == "__main__":
    main()
