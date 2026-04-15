var map;
var isMapLoaded = false;
var nowCities = [];
var mapMouseDown = false;

City.loadDataSync();
window.addEventListener("load", function (event) {
  // Load maps script
  loadMap();

  // On load page - get current cities from background service
  chrome.runtime.sendMessage("currentCities", (currentCities) => alertsListener(currentCities));

  // Listen to alerts
  chrome.runtime.onMessage.addListener((data) => {
    if (data.hasOwnProperty("cities") && !data.hasOwnProperty("flash"))
      data.cities.length ? alertsListener(data.cities || []) : window.close();
  });

  document.getElementById("copy").addEventListener("click", () => Preferences.copyAlert());
  document
    .getElementById("open")
    .addEventListener("click", () => Preferences.launchSiteMap(nowCities));
});

function getColorForThreat(threat) {
  switch (threat) {
    case 0: // Rockets
      return "#FF0000";
    case 1: // HazardousMaterials
      return "#9335ee";
    case 2: // Terrorists
      return "#FFD500";
    case 3: // Earthquake
      return "#00FF55";
    case 4: // Tsunami
      return "#0080FF";
    case 5: // UnmannedAircraft
      return "#FF8000";
    case 6: // NonConventionalMissile
    case 7: // Radiological
      return "#ee35a8";
    default: // GeneralAlert or others
      return "#FF0000";
  }
}

function isHigherPriorityThreat(threat, currentThreat) {
  if (threat == undefined || currentThreat == undefined) return false;
  const threatsPriority = [2, 7, 6, 1, 5, 4, 3, 0, 8, 9];
  return threatsPriority.indexOf(threat) < threatsPriority.indexOf(currentThreat);
}

const specialLocations = {
  // שדרות, איבים, ניר עם
  248: [
    [31.5227, 34.5956],
    [31.5335, 34.6096],
  ],
  // גבים, מכללת ספיר
  1759: [
    [31.5063, 34.5989],
    [31.5094, 34.5945],
  ],
  // מבטחים עמיעוז ישע
  135: [
    [31.2484, 34.4134],
    [31.2424, 34.4075],
    [31.2476, 34.4031],
  ],
  // קריית גת, כרמי גת
  293: [
    [31.6111, 34.7684],
    [31.6291, 34.7727],
  ],
  // מעגלים גבעולים מלילות
  200: [
    [31.3989, 34.5982],
    [31.3976, 34.5938],
    [31.3899, 34.5952],
  ],
  // צוחר ואוהד
  136: [
    [31.2372, 34.4264],
    [31.2384, 34.4319],
  ],
  // זמרת ושובה
  220: [
    [31.4479, 34.5523],
    [31.4499, 34.5455],
  ],
};

async function alertsListener(cities) {
  // Convert objects to City objects
  cities = cities.map((city) => new City(city.value, city.threat, city.isDrill, city.timestamp));
  nowCities = cities;

  const isAllDrill = cities.every((obj) => obj.isDrill == true || obj.threat == 9);
  const alertBox = document.getElementById("alert");
  const mapBox = document.getElementById("map");
  if (isAllDrill) {
    alertBox.classList.add("drill");
    mapBox.classList.add("drill");
  } else {
    alertBox.classList.remove("drill");
    mapBox.classList.remove("drill");
  }

  // Get elements

  var threatTitle = document.querySelector("#alert h3");
  var citiesDIV = document.querySelector(".cities-container");
  citiesDIV.innerHTML = "";

  // Threats titles
  const threatTitles = {};

  cities.reverse();
  cities.forEach((city) => {
    var cityNode = document.createElement("city");
    cityNode.textContent = city.getLocalizationCityName();
    if (Date.now() / 1000 - city.timestamp < 2) {
      cityNode.classList.add("blink");
    }
    cityNode.addEventListener("click", function (e) {
      if (!map) return;

      // Change map center on click
      const bounds = L.latLngBounds();
      city.getPolygon().forEach((point) => bounds.extend(point));
      if (city.lat && city.lng) bounds.extend([city.lat, city.lng]);

      if (bounds.isValid() && !mapMouseDown) {
        // Leaflet map fitBounds method
        map.fitBounds(bounds);
      }
    });
    citiesDIV.appendChild(cityNode);

    const title = City.getLocalizationThreatDrillTitle(city.threat, city.isDrill);
    threatTitles[title] = title;
  });
  threatTitle.textContent = Object.values(threatTitles).join(" | ");

  // Add polygons & Markers
  if (isMapLoaded) {
    addPolygonsMarkers(cities);
  }
}

const markersAndPolygons = {};
function addPolygonsMarkers(cities) {
  const bounds = L.latLngBounds();
  const citiesIds = new Set();

  cities.forEach((city) => {
    const cityId = city?.id;
    if (!cityId || (!city.lat && !city.lng)) return;

    citiesIds.add(String(cityId));

    const polygon = city.getPolygon();
    polygon.forEach((point) => bounds.extend(point));
    bounds.extend([city.lat, city.lng]);

    // we already have some map items for this city, return
    if (
      markersAndPolygons[cityId] &&
      !isHigherPriorityThreat(city.threat, markersAndPolygons[cityId]?.threat)
    )
      return;

    if (markersAndPolygons[cityId]) {
      map.removeLayer(markersAndPolygons[cityId].polygon);
      markersAndPolygons[cityId].markers.forEach((m) => map.removeLayer(m));
      // delete markersAndPolygons[cid];
    }

    const threatColor = getColorForThreat(city.threat);

    // create markers
    const points = specialLocations[cityId] ? specialLocations[cityId] : [[city.lat, city.lng]];
    const leafletMarkers = points.map(([lat, lng]) => {
      const marker = L.marker([lat, lng], {
        icon: L.icon({
          iconUrl: `/img/marker-threat${city.threat}.png`,
          iconSize: [20, 30],
          iconAnchor: [10, 30],
          popupAnchor: [0, 0],
          tooltipAnchor: [0, 0],
        }),
        // riseOnHover: true,
      });
      marker.addTo(map);
      return marker;
    });

    // create polygon
    const leafletPolygon = L.polygon(polygon, {
      color: threatColor,
      weight: 2,
      opacity: 0.7,
      fillOpacity: 0.3,
      fillColor: threatColor,
    }).addTo(map);

    // save for later
    markersAndPolygons[cityId] = {
      markers: leafletMarkers,
      polygon: leafletPolygon,
      threat: city.threat,
    };
  });

  // check if we need to remove some
  Object.keys(markersAndPolygons).forEach((cid) => {
    if (!citiesIds.has(cid)) {
      map.removeLayer(markersAndPolygons[cid].polygon);
      markersAndPolygons[cid].markers.forEach((m) => map.removeLayer(m));
      delete markersAndPolygons[cid];
    }
  });

  if (bounds.isValid() && !mapMouseDown) {
    // Leaflet map fitBounds method
    map.fitBounds(bounds, { padding: [10, 20] });
  }
}

async function loadMap() {
  // Load google map js
  const siteLanguage = await Preferences.getSelectedLanguage();

  map = L.map("map", { zoomControl: false }).setView([31.5469501, 34.6863132], 7);
  const mapLink = '<a target="_blank" href="https://www.google.com/maps">Google Maps</a>';

  map.attributionControl.setPrefix("");
  if (siteLanguage == "HE" || siteLanguage == "AR")
    map.attributionControl.setPosition("bottomleft");

  L.tileLayer(
    `https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=${siteLanguage.toLowerCase()}`,
    {
      maxZoom: 12,
      attribution: "&copy; " + mapLink,
      subdomains: ["mt0", "mt1", "mt2", "mt3"],
    }
  ).addTo(map);

  map.on("mousedown", function () {
    mapMouseDown = true;
  });

  map.on("mouseup", function () {
    mapMouseDown = false;
  });

  isMapLoaded = true;

  if (nowCities.length) addPolygonsMarkers(nowCities);
}
