# Nutrient targets: adult aged 31-50, lacto-vegetarian, Indian-leaning

Source for all targets: Health Canada Dietary Reference Intakes tables (31-50 y). RDA = recommended, AI = adequate intake, UL = tolerable upper limit, ND = not determined. Profile: male, 40.5 y, 183 cm, 93 kg (BMI 27.8). No medical conditions or allergies reported. Female values were dropped. Not medical advice; the PLAN.md rule still holds (no supplement doses in app data).

## Targets

| Nutrient | Target (male) | UL | In micros.json? |
|---|---|---|---|
| Protein | 0.8 g/kg (74 g at 93 kg) | n/a | yes |
| Fibre | 38 g (AI) | ND | yes |
| Carbohydrate (digestible) | 130 g | n/a | yes |
| Linoleic acid (n-6) | 17 g (AI) | ND | yes |
| Alpha-linolenic acid (n-3) | 1.6 g (AI) | ND | yes |
| Calcium | 1000 mg | 2500 mg | yes |
| Iron | 8 mg | 45 mg | yes |
| Zinc | 11 mg | 40 mg | yes |
| Magnesium | 420 mg | 350 mg (supplements only) | yes |
| Potassium | 3400 mg (AI) | ND | yes |
| Sodium | 1500 mg (AI), 2300 mg chronic-disease level | ND | yes |
| Phosphorus | 700 mg | 4000 mg | yes |
| Selenium | 55 ug | 400 ug | yes |
| Copper | 900 ug | 10000 ug | yes |
| Manganese | 2.3 mg (AI) | 11 mg | yes |
| Iodine | 150 ug | 1100 ug | **no: CNF has no iodine** |
| Vitamin A | 900 ug RAE | 3000 ug | yes (RAE) |
| Vitamin C | 90 mg | 2000 mg | yes |
| Vitamin D | 15 ug (600 IU) | 100 ug | yes |
| Vitamin E | 15 mg | 1000 mg | yes |
| Vitamin K | 120 ug (AI) | ND | yes |
| Thiamin / Riboflavin | 1.2 / 1.3 mg | ND | yes |
| Vitamin B6 | 1.3 mg | 100 mg | yes |
| Folate | 400 ug DFE | 1000 ug (folic acid only) | yes |
| Vitamin B12 | 2.4 ug | ND | yes |
| Choline | 550 mg (AI) | 3500 mg | yes |
| Water | 3.7 L (AI, all sources) | n/a | n/a |

Not yet pulled: niacin, pantothenic acid, biotin, chromium, molybdenum, fluoride (targets known, CNF coverage unchecked).

## Vegetarian / Indian risk nutrients, ranked

| Nutrient | Why it is a risk | Best sources found in the CNF data (per 100 g) |
|---|---|---|
| Vitamin B12 | Only dairy supplies it. Dal, rice, roti, tofu and tempeh give essentially none | Whey powder 2.45 ug, cottage cheese 0.63, Greek yogurt 0.18. A 150 g serving of Greek yogurt gives about 0.3 ug of the 2.4 ug target, so reaching it from dairy alone takes a lot of dairy. Fortified foods or a supplement are worth discussing with a doctor |
| Vitamin D | Almost nothing outside dairy; Canadian winter sun is low | Canadian milk is fortified: CNF 113, 61 and 114 carry 0.996 ug per 100 g (about 2.5 ug in a 250 mL glass, 17% of the 15 ug target). Skim milk powder 10.7 ug, ghee 1.8, butter 0.59. Fortified plant milks are not in the data |
| Iodine | Depends on iodized salt and dairy | Not in CNF at all; needs another source or the iodized-salt assumption |
| Iron | Non-heme, with absorption lowered by phytates and tea. Dal, rajma, chole, pumpkin and hemp seeds are strong | Soy isolate 14.5 mg, hemp 11.2, pumpkin seeds 8.8, rajma 8.2, chia 7.7, masoor 7.4 |
| Zinc | Phytates in legumes and whole grains cut absorption | Watermelon seeds 10.2 mg, hemp 9.1, pumpkin seeds 7.8, sesame 6.7, cashews 5.8 |
| Omega-3 (ALA) | No fish; EPA and DHA are absent from the whole data set | Flax 22.8 g, chia 17.8, walnuts 9.1, hemp 8.6. The 1.1-1.6 g ALA target is met by 1 tbsp ground flax |
| Calcium | Fine with dairy; weak without it | Chia 631 mg, whey 469, tahini 420, almonds 269, tofu 201 (calcium-set) |
| Protein quality | Legumes are low in methionine, grains low in lysine | Combine dal or rajma with roti, rice or dairy across the day |

Folate, magnesium, potassium and fibre are not a concern on this diet. Dal, rajma, chole, seeds and wholegrains cover them easily.

## Supplements

The household is open to supplementing B12 and vitamin D if needed. The app plans food only and holds no supplement doses (PLAN.md rule). The only supplement-related output is the single Settings line: ask a doctor about a blood test for B12, vitamin D and ferritin. Dose and form come from the test result and the doctor, not from this repo.

## Open points

- **Vegetarian iron and zinc, checked 2026-10-23.** Iron: the NIH Office of Dietary Supplements fact sheet (Iron, Health Professional) says the requirement is 1.8 times higher for vegetarians than for people who eat meat, because heme iron absorbs better than non-heme iron; that is the 2001 IOM figure, read here through the NIH page, not the report itself. Zinc: sources describe "up to 50% more" for strict vegetarians on grain and legume staples with a phytate to zinc molar ratio above 15:1, but the IOM report itself says there are not enough data to set an algorithm for it (secondhand quote), so 50% is a hedged upper bound, not a requirement. Neither multiplier is applied to the targets above or anywhere in the app: the iron total is read as an upper bound on what is absorbed, and zinc the same. To use the iron 1.8x, add it with the NIH page as its citation.
- Phytate is not in CNF, so absorption cannot be computed from the data. Treat the iron and zinc totals as upper bounds.
- Sodium: CNF values are as sold, and recipe salt is not counted until recipes exist.
- **Fortified milk: resolved** (CNF milk entries carry vitamin D, see the table).
- **Whole wheat atta** uses CNF 4500 (whole wheat flour), which is the standard nutrient stand-in; no separate IFCT row has been added. **Soya chunks** use CNF 3324 (defatted soy flour) as a labelled stand-in. **Paneer** has macros from IFCT2017-L003 with 15 micronutrients listed as `not_reported`; CNF has no paneer.
- **Still unresolved:** nutritional yeast (fortified B12), skyr, ultrafiltered milk and roasted chana have no usable CNF, USDA or IFCT entry in the data. Skyr, ultrafiltered milk and nutritional yeast are branded products: they need a label (Nutrition Facts photo) from you, then a `LABEL` source is allowed. Roasted chana needs an IFCT 2017 table lookup.
- **CNF was unreachable (HTTP 503) on 2026-10-23**, so `water-tap` and `hummus-commercial` stay on USDA values until it answers; switch them only if a CNF code is found, and report the macro change in the four recipes that use the hummus buy option.

## Gotchas

- CNF records zero for nutrients a food does not contain and omits others, so `micros.json` lists a `not_reported` array per ingredient. Do not read a missing value as zero when summing.
- Dry legumes are listed per 100 g dry weight. Multiply by `cooked_yield` to convert before comparing with cooked values.
