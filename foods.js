/* Tally — built-in reference foods.
 * Everyday UK items so the common case needs no network at all.
 *
 * Format: [name, category, kcal, protein, carbs, fat, defaultPortionLabel, defaultPortionGrams, extraPortions?]
 * All macro values are per 100 g (or per 100 ml for drinks, treated as grams).
 * Extra portions: [[label, grams], ...]
 *
 * Nutrition values come from McCance & Widdowson's Composition of Foods
 * Integrated Dataset (CoFID 2021, Open Government Licence v3.0) wherever a
 * clean equivalent exists — see tools/portion-map.json and
 * tools/apply-cofid-values.js. What this list adds on top of CoFID is PORTION
 * SIZES: a slice, a medium banana, half a tin. CoFID has none.
 *
 * The remaining few (composite dishes, takeaways) are estimates and are marked
 * as such. For a packaged product, scanning the barcode is always better.
 */
const BUILTIN_FOODS = [

/* ---- Dairy & eggs ---- */
["Milk, whole","Dairy",63,3.4,4.6,3.6,"glass (200 ml)",200,[["splash in tea (30 ml)",30],["100 ml",100]]],
["Milk, semi-skimmed","Dairy",46,3.5,4.7,1.7,"glass (200 ml)",200,[["splash in tea (30 ml)",30],["100 ml",100]]],
["Milk, skimmed","Dairy",34,3.5,4.8,0.3,"glass (200 ml)",200],
["Oat milk, unsweetened","Dairy alternative",45,1.0,6.7,1.5,"glass (200 ml)",200],
["Almond milk, unsweetened","Dairy alternative",13,0.5,0.3,1.1,"glass (200 ml)",200],
["Greek yoghurt, 0% fat","Dairy",57,10.0,4.0,0.4,"pot (170 g)",170],
["Greek yoghurt, full fat","Dairy",97,9.0,3.6,5.0,"pot (170 g)",170],
["Natural yoghurt","Dairy",79,5.7,7.8,3,"pot (150 g)",150],
["Cheddar cheese","Dairy",416,25.4,0.1,34.9,"matchbox (30 g)",30,[["slice (20 g)",20],["grated handful (40 g)",40]]],
["Mozzarella","Dairy",257,18.6,0,20.3,"ball (125 g)",125],
["Cream cheese","Dairy",253,5.5,4.1,23.8,"tbsp (30 g)",30],
["Butter","Dairy",744,0.6,0.6,82.2,"tsp (5 g)",5,[["thin spread (10 g)",10],["knob (15 g)",15]]],
["Double cream","Dairy",496,1.6,1.7,53.7,"tbsp (15 g)",15],
["Egg, boiled or poached","Eggs",143,14.1,0,9.6,"medium egg (58 g)",58,[["large egg (68 g)",68],["two eggs (116 g)",116]]],
["Egg, fried","Eggs",200,14.7,0,15.7,"egg (61 g)",61],
["Egg, scrambled with milk","Eggs",155,10.5,1.6,11.6,"two eggs (140 g)",140],

/* ---- Meat, fish & protein ---- */
["Chicken breast, raw","Meat",106,24.0,0,1.1,"breast (170 g)",170,[["100 g",100]]],
["Chicken breast, cooked","Meat",148,32,0,2.2,"breast (140 g)",140,[["100 g",100]]],
["Chicken thigh, cooked","Meat",180,25.6,0,8.6,"thigh (75 g)",75],
["Beef mince, 5% fat, raw","Meat",137,21.5,0,5.0,"portion (125 g)",125],
["Beef mince, 20% fat, raw","Meat",254,17.2,0,20.0,"portion (125 g)",125],
["Steak, sirloin, cooked","Meat",214,30.0,0,10.0,"steak (200 g)",200],
["Pork sausage, cooked","Meat",290,14.0,10.0,22.0,"sausage (50 g)",50,[["two sausages (100 g)",100]]],
["Bacon, back, grilled","Meat",287,23.2,0,21.6,"rasher (25 g)",25,[["two rashers (50 g)",50]]],
["Ham, sliced","Meat",107,18.4,1,3.3,"slice (20 g)",20],
["Salmon fillet, cooked","Fish",231,25.0,0,14.0,"fillet (130 g)",130],
["Tuna, canned in brine","Fish",109,24.9,0,1,"drained tin (110 g)",110],
["Cod fillet, cooked","Fish",105,23.0,0,0.9,"fillet (140 g)",140],
["Prawns, cooked","Fish",68,16.2,0,0.4,"handful (75 g)",75],
["Tofu, steamed","Plant protein",73,8.1,0.7,4.2,"block half (150 g)",150],
["Halloumi","Dairy",313,23.9,1.7,23.5,"two slices (60 g)",60],

/* ---- Bread & baked ---- */
["Bread, white","Bread",219,7.9,46.1,1.6,"medium slice (36 g)",36,[["two slices (72 g)",72],["thick slice (44 g)",44]]],
["Bread, wholemeal","Bread",217,9.4,42,2.5,"medium slice (40 g)",40,[["two slices (80 g)",80]]],
["Bread, sourdough","Bread",270,10.0,52.0,1.5,"slice (50 g)",50],
["Bagel, plain","Bread",273,10,57.8,1.8,"bagel (85 g)",85],
["Pitta bread, white","Bread",255,9.1,55.1,1.3,"pitta (60 g)",60],
["Tortilla wrap, white","Bread",306,8.2,51.0,7.5,"wrap (62 g)",62],
["Croissant","Bakery",373,8.3,43.3,19.7,"croissant (60 g)",60],
["Crumpet","Bakery",180,6.0,36.0,0.9,"crumpet (55 g)",55],

/* ---- Cereals & grains ---- */
["Porridge oats, dry","Cereal",381,10.9,70.7,8.1,"serving (40 g)",40,[["large bowl (60 g)",60]]],
["Weetabix","Cereal",332,10.5,72.7,1.9,"biscuit (19 g)",19,[["two biscuits (38 g)",38]]],
["Cornflakes","Cereal",376,7.1,90.9,0.8,"bowl (30 g)",30],
["Granola","Cereal",471,10.0,60.0,20.0,"serving (45 g)",45],
["Muesli","Cereal",366,9.2,72.6,6.3,"serving (45 g)",45],
["Rice, white, boiled","Grain",117,2.8,26.5,0.7,"portion (180 g)",180,[["100 g",100]]],
["Rice, white, dry","Grain",356,7.0,78.0,1.0,"portion (75 g)",75],
["Rice, brown, boiled","Grain",132,3.6,29.2,0.9,"portion (180 g)",180],
["Pasta, cooked","Grain",169,5.5,37.2,0.8,"portion (200 g)",200,[["100 g",100]]],
["Pasta, dry","Grain",343,11.3,75.6,1.6,"portion (85 g)",85,[["100 g",100]]],
["Couscous, cooked","Grain",178,7.2,37.5,1,"portion (180 g)",180],
["Quinoa, cooked","Grain",120,4.4,21.0,1.9,"portion (180 g)",180],
["Noodles, egg, cooked","Grain",138,4.5,25.0,2.1,"nest (150 g)",150],

/* ---- Potatoes ---- */
["Potatoes, boiled","Vegetables",74,1.8,17.5,0.1,"portion (180 g)",180],
["Potatoes, roast","Vegetables",149,2.9,26.0,4.5,"portion (150 g)",150],
["Chips, oven","Vegetables",162,2.6,26.0,5.1,"portion (150 g)",150],
["Chips, chip shop","Takeaway",239,3.7,30.0,12.0,"portion (200 g)",200],
["Sweet potato, baked","Vegetables",115,1.6,27.9,0.4,"medium (150 g)",150],
["Jacket potato, baked","Vegetables",93,2.5,21.0,0.1,"medium (200 g)",200],

/* ---- Beans & pulses ---- */
["Baked beans in tomato sauce","Beans",81,5,15,0.5,"half tin (207 g)",207,[["full tin (415 g)",415]]],
["Chickpeas, canned, drained","Beans",129,8.4,18.3,3,"half tin (120 g)",120],
["Lentils, cooked","Beans",102,8.1,16.9,0.7,"portion (150 g)",150],
["Kidney beans, canned","Beans",100,8.6,15.1,1,"half tin (120 g)",120],
["Hummus","Dips",307,6.8,10.5,26.7,"tbsp (30 g)",30,[["pot half (85 g)",85]]],

/* ---- Vegetables ---- */
["Broccoli, boiled","Vegetables",28,3.3,2.8,0.5,"portion (85 g)",85],
["Carrots, raw","Vegetables",34,0.5,7.7,0.4,"medium carrot (60 g)",60],
["Peas, frozen, boiled","Vegetables",70,5.5,11.2,0.7,"portion (80 g)",80],
["Spinach, raw","Vegetables",16,2.6,0.2,0.6,"handful (30 g)",30],
["Tomato","Vegetables",14,0.5,3,0.1,"medium (85 g)",85],
["Cucumber","Vegetables",14,1,1.2,0.6,"5 cm piece (60 g)",60],
["Onion","Vegetables",35,1,8,0.1,"medium (110 g)",110],
["Mushrooms","Vegetables",7,1,0.3,0.2,"handful (80 g)",80],
["Pepper, bell","Vegetables",15,0.8,2.6,0.3,"medium (120 g)",120],
["Lettuce","Vegetables",15,1.4,2.9,0.2,"handful (35 g)",35],
["Sweetcorn, canned","Vegetables",78,2.6,13.9,1.7,"portion (80 g)",80],
["Salad, mixed leaves","Vegetables",17,1.4,2.0,0.3,"bowl (80 g)",80],

/* ---- Fruit ---- */
["Banana","Fruit",81,1.2,20.3,0.1,"medium (118 g)",118,[["small (100 g)",100],["large (140 g)",140]]],
["Apple","Fruit",51,0.6,11.6,0.5,"medium (150 g)",150],
["Orange","Fruit",36,0.8,8.2,0.2,"medium (140 g)",140],
["Strawberries","Fruit",30,0.6,6.1,0.5,"handful (100 g)",100],
["Blueberries","Fruit",40,0.9,9.1,0.2,"handful (80 g)",80],
["Grapes","Fruit",65,0.7,16.1,0.2,"handful (80 g)",80],
["Avocado","Fruit",171,1.8,1.8,17.4,"half (100 g)",100,[["whole (200 g)",200]]],
["Raisins","Fruit",256,3,62.6,1,"small box (30 g)",30],
["Pear","Fruit",44,0.3,11.3,0.1,"medium (170 g)",170],

/* ---- Fats, nuts & spreads ---- */
["Olive oil","Fats",899,0,0,99.9,"tbsp (14 g)",14,[["tsp (5 g)",5],["drizzle (7 g)",7]]],
["Vegetable oil","Fats",899,0,0,99.9,"tbsp (14 g)",14],
["Peanut butter","Spreads",607,22.8,13.1,51.8,"tbsp (16 g)",16,[["heaped tbsp (32 g)",32]]],
["Almonds","Nuts",554,21.2,5.3,49.9,"handful (30 g)",30],
["Cashews","Nuts",573,17.7,18.1,48.2,"handful (30 g)",30],
["Walnuts","Nuts",688,14.7,3.3,68.5,"handful (30 g)",30],
["Mayonnaise","Condiments",686,1.1,2.4,74.8,"tbsp (15 g)",15],
["Jam","Spreads",261,0.4,69.3,0,"tsp (10 g)",10],

/* ---- Snacks & sweets ---- */
["Chocolate, milk","Snacks",519,7.3,56,31.1,"4 squares (25 g)",25,[["standard bar (45 g)",45]]],
["Chocolate, dark 70%","Snacks",510,5,63.5,28,"4 squares (25 g)",25],
["Digestive biscuit","Snacks",471,6.7,63.0,21.0,"biscuit (15 g)",15,[["two biscuits (30 g)",30]]],
["Crisps, ready salted","Snacks",493,6.2,55.8,28.8,"small bag (25 g)",25],
["Flapjack","Snacks",460,5.0,60.0,22.0,"piece (70 g)",70],
["Ice cream, vanilla","Snacks",169,3.2,22,8.2,"two scoops (100 g)",100],
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
["Lager, 4.5%","Drinks",24,0.3,0,0,"pint (568 ml)",568,[["bottle (330 ml)",330],["half pint (284 ml)",284]]],
["Wine, red","Drinks",76,0.1,0.2,0,"medium glass (175 ml)",175,[["large glass (250 ml)",250],["small glass (125 ml)",125]]],
["Wine, white, dry","Drinks",75,0.1,0.6,0,"medium glass (175 ml)",175,[["large glass (250 ml)",250]]],
["Spirits, 40%","Drinks",231,0,0,0,"single (25 ml)",25,[["double (50 ml)",50]]],
["Cola","Drinks",41,0,10.9,0,"can (330 ml)",330],
["Cola, diet","Drinks",1,0,0,0,"can (330 ml)",330],
["Orange juice","Drinks",36,0.9,8.6,0,"glass (200 ml)",200],
["Coffee, black","Drinks",2,0.2,0.3,0,"mug (240 ml)",240],
["Tea with semi-skimmed milk","Drinks",7,0.5,0.7,0.2,"mug (240 ml)",240],
["Latte with semi-skimmed milk","Drinks",55,3.1,5.3,2.1,"medium (350 ml)",350],

/* ---- Condiments ---- */
["Tomato ketchup","Condiments",115,1.6,28.6,0.1,"tbsp (15 g)",15],
["Honey","Condiments",288,0.4,76.4,0,"tsp (7 g)",7],
["Sugar","Condiments",394,0,105,0,"tsp (4 g)",4],
["Soy sauce","Condiments",79,3,17.9,0,"tbsp (15 g)",15],
["Gravy, made up","Condiments",34,0.6,5.4,1.1,"portion (70 g)",70]
];

if (typeof module !== "undefined") module.exports = { BUILTIN_FOODS };
