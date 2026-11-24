node_keys = { "place" }
function node_function()
  local place = Find("place")
  if place == "city" or place == "town" or place == "village" or place == "hamlet" then
    Layer("place", false)
    Attribute("name", Find("name"))
  end
end
function way_function()
  local highway = Find("highway")
  if highway ~= "" and highway ~= "construction" and highway ~= "proposed" then
    Layer("transportation", false)
    Attribute("class", highway)
    if highway ~= "motorway" and highway ~= "trunk" and highway ~= "primary" and highway ~= "secondary" then MinZoom(11) end
    local name = Find("name")
    if name ~= "" then
      Layer("transportation_name", false)
      Attribute("name", name)
    end
  end
  if IsClosed() and Find("building") ~= "" and Find("building") ~= "no" then
    Layer("building", true)
    local height = tonumber(Find("height")) or (tonumber(Find("building:levels")) or 2) * 3
    AttributeNumeric("render_height", math.min(height, 250))
  end
  if IsClosed() and Find("natural") == "water" then Layer("water", true) end
end
