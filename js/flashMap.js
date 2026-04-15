var map;
var isMapLoaded = false;
var lastCitiesIds = [];
var mapMouseDown = false;
const flashMessages = [];
let timeoutId;

const resetTimeout = () => {
  clearTimeout(timeoutId)

  timeoutId = setInterval(() => {
    window.close()
  }, 180 * 1000);
}

City.loadDataSync();

function getFlashMessages() {
  return flashMessages.filter((z) => z.expireAt >= Date.now()).toReversed();
}

async function copyFlashUpdates() {
  function getTimeString(date, minutesOnly = false) {
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const seconds = date.getSeconds().toString().padStart(2, "0");
    return hours + ":" + minutes + (minutesOnly ? "" : ":" + seconds);
  }
  function getDateString(date, shortYear = false) {
    const date_ = ("0" + date.getDate()).slice(-2);
    const month = ("0" + (date.getMonth() + 1)).slice(-2);
    const year = shortYear ? date.getYear().toString().substr(1, 2) : date.getFullYear();
    return date_ + "/" + month + "/" + year;
  }

  function getDateTime(ts){
    return getDateString(new Date(ts)) + " "  + getTimeString(new Date(ts), true)
  }

  const string =
    getFlashMessages()
      .map((i) => `${i.title} (${getDateTime(i.ts)})\n${i.body}`)
      .join("\n\n") +
    "\n\n" +
    (STRINGS.sentVia[City.siteLanguage.toLowerCase()] || STRINGS.sentVia.he) +
    "\n" +
    Preferences.getSystemsPageUrl(City.siteLanguage);

  navigator.clipboard.writeText(string);
}

window.addEventListener("load", function (event) {
  // Load maps script
  loadMap();

  // On load page - get current cities from background service
  chrome.runtime.sendMessage("activeFlashMessages", (activeFlashs) =>
    activeFlashs.forEach((f) => flashListener(f))
  );

  // Listen to alerts
  chrome.runtime.onMessage.addListener((data) => {
    if (data.hasOwnProperty("flash")) flashListener(data.flash);
  });

  document.getElementById("copy").addEventListener("click", () => copyFlashUpdates());
});


async function flashListener(flashUpdate) {
  resetTimeout()
  flashMessages.push(flashUpdate);


  // Get elements

  var threatTitle = document.querySelector("#alert h3");
  var citiesDIV = document.querySelector(".cities-container");
  citiesDIV.innerHTML = "";

  // Threats titles
  const titles = {};
  const totalCitiesIds = {};

  getFlashMessages().forEach(({ citiesIds, title, body, ts, expireAt }) => {
    titles[title] = title;
    citiesIds.forEach((id) => (totalCitiesIds[id] = id));

    var cityNode = document.createElement("city");
    cityNode.textContent = body;
    if (Date.now() - ts < 2_000) {
      cityNode.classList.add("blink");
    }
    citiesDIV.appendChild(cityNode);
  });
  threatTitle.textContent = Object.keys(titles).join(" | ");
  document.title = threatTitle.textContent

  lastCitiesIds = Object.keys(totalCitiesIds);
  // Add polygons & Markers
  if (isMapLoaded) {
    addPolygonsMarkers(lastCitiesIds);
  }
}

const markersAndPolygons = {};
function addPolygonsMarkers(citiesIds) {
  const bounds = L.latLngBounds();

  citiesIds.forEach((cityId) => {
    const polygon = City.POLYGONS[cityId];

    if (!polygon) return;
    polygon.forEach((point) => bounds.extend(point));

    if (markersAndPolygons[cityId]) {
      map.removeLayer(markersAndPolygons[cityId].polygon);
      // delete markersAndPolygons[cid];
    }

    // create polygon
    const leafletPolygon = L.polygon(polygon, {
      color: "#FF0000",
      weight: 2,
      opacity: 0.7,
      fillOpacity: 0.3,
      fillColor: "#FF0000",
    }).addTo(map);

    // save for later
    markersAndPolygons[cityId] = {
      polygon: leafletPolygon,
    };
  });

  // check if we need to remove some
  Object.keys(markersAndPolygons).forEach((cid) => {
    if (!citiesIds.includes(cid)) {
      map.removeLayer(markersAndPolygons[cid].polygon);
      delete markersAndPolygons[cid];
    }
  });

  if (bounds.isValid() && !mapMouseDown) {
    // Leaflet map fitBounds method
    map.fitBounds(bounds);
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

  if (lastCitiesIds.length) addPolygonsMarkers(lastCitiesIds);
}
