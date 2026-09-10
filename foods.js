/* Tally — built-in reference foods.
 * Everyday UK items so the common case needs no network at all.
 *
 * Format: [name, category, kcal, protein, carbs, fat, defaultPortionLabel, defaultPortionGrams, extraPortions?]
 * All macro values are per 100 g (or per 100 ml for drinks, treated as grams).
 * Extra portions: [[label, grams], ...]
 *
 * These are typical reference values for generic foods, not any specific brand.
 * For a packaged product, scanning its barcode will always be more accurate.
 */
const BUILTIN_FOODS = [

/* ---- Dairy & eggs ---- */
["Milk, whole","Dairy",64,3.4,4.7,3.6,"glass (200 ml)",200,[["splash in tea (30 ml)",30],["100 ml",100]]],
["Milk, semi-skimmed","Dairy",50,3.6,4.8,1.8,"glass (200 ml)",200,[["splash in tea (30 ml)",30],["100 ml",100]]],
["Milk, skimmed","Dairy",35,3.6,5.0,0.2,"glass (200 ml)",200],
["Oat milk, unsweetened","Dairy alternative",45,1.0,6.7,1.5,"glass (200 ml)",200],
["Almond milk, unsweetened","Dairy alternative",13,0.5,0.3,1.1,"glass (200 ml)",200],
["Greek yoghurt, 0% fat","Dairy",57,10.0,4.0,0.4,"pot (170 g)",170],
["Greek yoghurt, full fat","Dairy",97,9.0,3.6,5.0,"pot (170 g)",170],
["Natural yoghurt","Dairy",79,4.4,5.6,4.3,"pot (150 g)",150],
["Cheddar cheese","Dairy",416,25.4,0.1,34.9,"matchbox (30 g)",30,[["slice (20 g)",20],["grated handful (40 g)",40]]],
["Mozzarella","Dairy",280,22.0,2.2,20.0,"ball (125 g)",125],
["Cream cheese","Dairy",253,5.5,4.1,23.8,"tbsp (30 g)",30],
["Butter","Dairy",744,0.6,0.6,82.0,"tsp (5 g)",5,[["thin spread (10 g)",10],["knob (15 g)",15]]],
["Double cream","Dairy",449,1.7,2.7,47.5,"tbsp (15 g)",15],
["Egg, boiled or poached","Eggs",143,12.6,0.7,9.5,"medium egg (58 g)",58,[["large egg (68 g)",68],["two eggs (116 g)",116]]],
["Egg, fried","Eggs",196,13.6,0.8,15.0,"egg (61 g)",61],
["Egg, scrambled with milk","Eggs",155,10.5,1.6,11.6,"two eggs (140 g)",140],

/* ---- Meat, fish & protein ---- */
["Chicken breast, raw","Meat",106,24.0,0,1.1,"breast (170 g)",170,[["100 g",100]]],
["Chicken breast, cooked","Meat",165,31.0,0,3.6,"breast (140 g)",140,[["100 g",100]]],
["Chicken thigh, cooked","Meat",209,26.0,0,10.9,"thigh (75 g)",75],
["Beef mince, 5% fat, raw","Meat",137,21.5,0,5.0,"portion (125 g)",125],
["Beef mince, 20% fat, raw","Meat",254,17.2,0,20.0,"portion (125 g)",125],
["Steak, sirloin, cooked","Meat",214,30.0,0,10.0,"steak (200 g)",200],
["Pork sausage, cooked","Meat",290,14.0,10.0,22.0,"sausage (50 g)",50,[["two sausages (100 g)",100]]],
["Bacon, back, grilled","Meat",287,23.0,0.4,21.0,"rasher (25 g)",25,[["two rashers (50 g)",50]]],
["Ham, sliced","Meat",107,18.0,1.5,3.3,"slice (20 g)",20],
["Salmon fillet, cooked","Fish",231,25.0,0,14.0,"fillet (130 g)",130],
["Tuna, canned in brine","Fish",108,25.0,0,0.8,"drained tin (110 g)",110],
["Cod fillet, cooked","Fish",105,23.0,0,0.9,"fillet (140 g)",140],
["Prawns, cooked","Fish",99,20.9,0.2,1.4,"handful (75 g)",75],
["Tofu, firm","Plant protein",144,15.8,2.3,8.7,"block half (150 g)",150],
["Halloumi","Dairy",321,22.0,2.2,25.0,"two slices (60 g)",60],

/* ---- Bread & baked ---- */
["Bread, white","Bread",265,9.0,49.0,3.2,"medium slice (36 g)",36,[["two slices (72 g)",72],["thick slice (44 g)",44]]],
["Bread, wholemeal","Bread",247,10.5,41.5,3.4,"medium slice (40 g)",40,[["two slices (80 g)",80]]],
["Bread, sourdough","Bread",270,10.0,52.0,1.5,"slice (50 g)",50],
["Bagel, plain","Bread",271,10.5,51.0,1.7,"bagel (85 g)",85],
["Pitta bread, white","Bread",275,9.1,55.0,1.2,"pitta (60 g)",60],
["Tortilla wrap, white","Bread",306,8.2,51.0,7.5,"wrap (62 g)",62],
["Croissant","Bakery",406,8.2,46.0,21.0,"croissant (60 g)",60],
["Crumpet","Bakery",180,6.0,36.0,0.9,"crumpet (55 g)",55],

/* ---- Cereals & grains ---- */
["Porridge oats, dry","Cereal",379,11.2,60.0,8.1,"serving (40 g)",40,[["large bowl (60 g)",60]]],
["Weetabix","Cereal",362,12.0,69.0,2.0,"biscuit (19 g)",19,[["two biscuits (38 g)",38]]],
["Cornflakes","Cereal",378,7.0,84.0,0.9,"bowl (30 g)",30],
["Granola","Cereal",471,10.0,60.0,20.0,"serving (45 g)",45],
["Muesli","Cereal",363,9.8,66.0,5.9,"serving (45 g)",45],
["Rice, white, boiled","Grain",130,2.7,28.0,0.3,"portion (180 g)",180,[["100 g",100]]],
["Rice, white, dry","Grain",356,7.0,78.0,1.0,"portion (75 g)",75],
["Rice, brown, boiled","Grain",132,2.7,28.0,1.1,"portion (180 g)",180],
["Pasta, cooked","Grain",158,5.8,31.0,0.9,"portion (200 g)",200,[["100 g",100]]],
["Pasta, dry","Grain",359,12.5,71.0,1.8,"portion (85 g)",85,[["100 g",100]]],
["Couscous, cooked","Grain",112,3.8,23.0,0.2,"portion (180 g)",180],
["Quinoa, cooked","Grain",120,4.4,21.0,1.9,"portion (180 g)",180],
["Noodles, egg, cooked","Grain",138,4.5,25.0,2.1,"nest (150 g)",150],

/* ---- Potatoes ---- */
["Potatoes, boiled","Vegetables",77,1.8,17.0,0.1,"portion (180 g)",180],
["Potatoes, roast","Vegetables",149,2.9,26.0,4.5,"portion (150 g)",150],
["Chips, oven","Vegetables",162,2.6,26.0,5.1,"portion (150 g)",150],
["Chips, chip shop","Takeaway",239,3.7,30.0,12.0,"portion (200 g)",200],
["Sweet potato, baked","Vegetables",90,2.0,21.0,0.2,"medium (150 g)",150],
["Jacket potato, baked","Vegetables",93,2.5,21.0,0.1,"medium (200 g)",200],

/* ---- Beans & pulses ---- */
["Baked beans in tomato sauce","Beans",78,4.7,12.9,0.2,"half tin (207 g)",207,[["full tin (415 g)",415]]],
["Chickpeas, canned, drained","Beans",139,7.2,17.0,2.6,"half tin (120 g)",120],
["Lentils, cooked","Beans",116,9.0,20.0,0.4,"portion (150 g)",150],
["Kidney beans, canned","Beans",100,6.9,15.0,0.5,"half tin (120 g)",120],
["Hummus","Dips",306,7.5,12.0,25.0,"tbsp (30 g)",30,[["pot half (85 g)",85]]],

/* ---- Vegetables ---- */
["Broccoli, boiled","Vegetables",35,2.4,4.0,0.4,"portion (85 g)",85],
["Carrots, raw","Vegetables",41,0.9,9.6,0.2,"medium carrot (60 g)",60],
["Peas, frozen, boiled","Vegetables",79,5.4,9.5,0.9,"portion (80 g)",80],
["Spinach, raw","Vegetables",23,2.9,1.4,0.4,"handful (30 g)",30],
["Tomato","Vegetables",18,0.9,3.9,0.2,"medium (85 g)",85],
["Cucumber","Vegetables",15,0.7,3.6,0.1,"5 cm piece (60 g)",60],
["Onion","Vegetables",40,1.1,9.3,0.1,"medium (110 g)",110],
["Mushrooms","Vegetables",22,3.1,0.3,0.3,"handful (80 g)",80],
["Pepper, bell","Vegetables",26,1.0,6.0,0.3,"medium (120 g)",120],
["Lettuce","Vegetables",15,1.4,2.9,0.2,"handful (35 g)",35],
["Sweetcorn, canned","Vegetables",86,3.2,19.0,1.2,"portion (80 g)",80],
["Salad, mixed leaves","Vegetables",17,1.4,2.0,0.3,"bowl (80 g)",80],

/* ---- Fruit ---- */
["Banana","Fruit",89,1.1,23.0,0.3,"medium (118 g)",118,[["small (100 g)",100],["large (140 g)",140]]],
["Apple","Fruit",52,0.3,14.0,0.2,"medium (150 g)",150],
["Orange","Fruit",47,0.9,12.0,0.1,"medium (140 g)",140],
["Strawberries","Fruit",32,0.7,7.7,0.3,"handful (100 g)",100],
["Blueberries","Fruit",57,0.7,14.0,0.3,"handful (80 g)",80],
["Grapes","Fruit",69,0.7,18.0,0.2,"handful (80 g)",80],
["Avocado","Fruit",160,2.0,8.5,15.0,"half (100 g)",100,[["whole (200 g)",200]]],
["Raisins","Fruit",299,3.1,79.0,0.5,"small box (30 g)",30],
["Pear","Fruit",57,0.4,15.0,0.1,"medium (170 g)",170],

/* ---- Fats, nuts & spreads ---- */
["Olive oil","Fats",884,0,0,100.0,"tbsp (14 g)",14,[["tsp (5 g)",5],["drizzle (7 g)",7]]],
["Vegetable oil","Fats",884,0,0,100.0,"tbsp (14 g)",14],
["Peanut butter","Spreads",588,25.0,20.0,50.0,"tbsp (16 g)",16,[["heaped tbsp (32 g)",32]]],
["Almonds","Nuts",579,21.0,22.0,50.0,"handful (30 g)",30],
["Cashews","Nuts",553,18.0,30.0,44.0,"handful (30 g)",30],
["Walnuts","Nuts",654,15.0,14.0,65.0,"handful (30 g)",30],
["Mayonnaise","Condiments",680,1.0,1.3,75.0,"tbsp (15 g)",15],
["Jam","Spreads",278,0.4,69.0,0.1,"tsp (10 g)",10],

/* ---- Snacks & sweets ---- */
["Chocolate, milk","Snacks",535,7.6,59.0,30.0,"4 squares (25 g)",25,[["standard bar (45 g)",45]]],
["Chocolate, dark 70%","Snacks",598,7.8,46.0,43.0,"4 squares (25 g)",25],
["Digestive biscuit","Snacks",471,6.7,63.0,21.0,"biscuit (15 g)",15,[["two biscuits (30 g)",30]]],
["Crisps, ready salted","Snacks",533,6.0,51.0,33.0,"small bag (25 g)",25],
["Flapjack","Snacks",460,5.0,60.0,22.0,"piece (70 g)",70],
["Ice cream, vanilla","Snacks",207,3.5,24.0,11.0,"two scoops (100 g)",100],
["Cereal bar","Snacks",420,5.5,68.0,13.0,"bar (35 g)",35],

/* ---- Prepared & takeaway ---- */
["Pizza, cheese & tomato","Prepared",266,11.0,33.0,10.0,"slice (100 g)",100,[["half a 12in (250 g)",250]]],
["Chicken curry with rice","Takeaway",145,7.0,17.0,5.5,"portion (400 g)",400],
["Fish and chips","Takeaway",195,9.0,20.0,9.5,"portion (350 g)",350],
["Cheese sandwich","Prepared",280,11.0,28.0,13.0,"sandwich (180 g)",180],
["Chicken salad sandwich","Prepared",200,11.0,24.0,6.5,"sandwich (180 g)",180],
["Soup, vegetable","Prepared",45,1.4,7.5,1.1,"half tin (200 g)",200],
["Beef burger in a bun","Takeaway",255,13.0,20.0,13.0,"burger (200 g)",200],

/* ---- Drinks ---- */
["Lager, 4.5%","Drinks",43,0.5,3.6,0,"pint (568 ml)",568,[["bottle (330 ml)",330],["half pint (284 ml)",284]]],
["Wine, red","Drinks",85,0.1,2.6,0,"medium glass (175 ml)",175,[["large glass (250 ml)",250],["small glass (125 ml)",125]]],
["Wine, white, dry","Drinks",82,0.1,2.6,0,"medium glass (175 ml)",175,[["large glass (250 ml)",250]]],
["Spirits, 40%","Drinks",231,0,0,0,"single (25 ml)",25,[["double (50 ml)",50]]],
["Cola","Drinks",42,0,10.6,0,"can (330 ml)",330],
["Cola, diet","Drinks",0.3,0,0,0,"can (330 ml)",330],
["Orange juice","Drinks",45,0.7,10.4,0.2,"glass (200 ml)",200],
["Coffee, black","Drinks",2,0.1,0,0,"mug (240 ml)",240],
["Tea with semi-skimmed milk","Drinks",13,0.7,1.0,0.4,"mug (240 ml)",240],
["Latte with semi-skimmed milk","Drinks",55,3.1,5.3,2.1,"medium (350 ml)",350],

/* ---- Condiments ---- */
["Tomato ketchup","Condiments",102,1.2,24.0,0.1,"tbsp (15 g)",15],
["Honey","Condiments",304,0.3,82.0,0,"tsp (7 g)",7],
["Sugar","Condiments",400,0,100.0,0,"tsp (4 g)",4],
["Soy sauce","Condiments",53,8.0,4.9,0.1,"tbsp (15 g)",15],
["Gravy, made up","Condiments",34,0.6,5.4,1.1,"portion (70 g)",70]
];

if (typeof module !== "undefined") module.exports = { BUILTIN_FOODS };
