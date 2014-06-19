"use strict"

var DIM_CACHE = {}
var DATA_CACHE = {}
var DRILL_CACHE = {}


var to_money = function(Amount, Symbol) {
    var DecimalSeparator = Number("1.2").toLocaleString().substr(1,1);

    var AmountWithCommas = Amount.toLocaleString();
    var arParts = String(AmountWithCommas).split(DecimalSeparator);
    var intPart = arParts[0];
    var decPart = (arParts.length > 1 ? arParts[1] : '');
    decPart = (decPart + '00').substr(0,2);

    return intPart + DecimalSeparator + decPart + ' ' + Symbol;
}


var Space = function(name, label) {
    this.name = name;
    this.label = label;
};


var Measure = function(space, name, label) {
    this.space = space;
    this.name = this.space.name + '.' + name;
    this.label = label;
    this.fullname = this.space.label +' / ' + this.label;
};


var Coordinate = function(dimension, parent, value) {
    this.value = value;
    this.parent = parent;
    this.dimension = dimension;
    this.active = ko.observable(false);
    this.children = [];
    this.label = dimension.label;
    if (this.value.length) {
        this.label = this.value[this.value.length-1];
    }
};

Coordinate.prototype.drill = function(value) {
    var query = {
        'space': this.dimension.dimsel.dataset.measures()[0].space.name,
        'dimension': this.dimension.name,
        'value': this.value,
    }

    query = JSON.stringify(query);
    var callback = function(res) {
        this.add_children(res.data);
        this.dimension.selected_coord(this);
    }.bind(this)

    if (query in DRILL_CACHE) {
        callback(DRILL_CACHE[query])
        return;
    }

    var url = '/mng/drill.json?' + $.param({'query': query});
    var prm = $.ajax(url)
    prm.success(function(res) {
        DRILL_CACHE[query] = res;
        callback(res);
    });
    return prm;
};

Coordinate.prototype.add_children = function(names) {
    var children = [];
    for (var pos in names) {
        var name = names[pos];
        var value = this.value.slice();
        value.push(name);
        var child = new Coordinate(this.dimension, this, value);
        children.push(child);
    }
    this.children = children;
};

Coordinate.prototype.activate = function() {
    if (this.active()) {
        this.active(false);
        return;
    }

    this.dimension.choice().forEach(function(d) {
        d.active(false);
    }.bind(this))
    this.active(true);
};

Coordinate.prototype.has_children = function() {
    return this.value.length < this.dimension.levels().length;
};

Coordinate.prototype.set_value = function(value) {
    if (!value || !value.length) {
        return;
    }

    var prm = this.drill();
    if (!value[0]) {
        prm.success(function() {
            this.dimension.selected_coord(this);
        }.bind(this));
        return prm;
    }

    var chained_prm = prm.then(function() {
        for (var pos in this.children) {
            var child = this.children[pos];
            var last_val = child.value[child.value.length - 1];
            if (last_val != value[0]) {
                continue;
            }
            value = value.splice(1);
            if (value.length) {
                return child.set_value(value);
            }
            child.activate();
            break;
        }
    }.bind(this));
    return chained_prm;
};


var Dimension = function(name, label, levels, dimsel) {
    this.name = name;
    this.label = label;
    this.dimsel = dimsel;
    this.active = ko.observable(false);
    this.selected_coord = ko.observable();
    this.levels = ko.observable(levels);
};

Dimension.prototype.choice = function() {
    return this.selected_coord().children;
};

Dimension.prototype.has_children = function() {
    return true;
};

Dimension.prototype.drill = function() {
    this.activate();
    var root = new Coordinate(this, null, []);
    this.selected_coord(root);
    root.drill();
};

Dimension.prototype.activate = function() {
    var old = this.dimsel.selected_dim()
    old && old.active(false);
    this.dimsel.selected_dim(this);
    this.active(true);
};

Dimension.prototype.drill_up = function() {
    this.selected_coord(this.selected_coord().parent);
};

Dimension.prototype.set_value = function(value) {
    var root = new Coordinate(this, null, []);
    this.selected_coord(root);
    root.set_value(value);
}

Dimension.prototype.get_value = function() {
    var coord = this.selected_coord();
    if (coord) {
        var actives = this.choice().filter(function(d) {
            return d.active();
        });
        if (actives.length) {
            return actives[0].value;
        }
        var val = coord.value.slice();
        val.push(null);
        for (var i = val.length; i <= this.dimsel.level_index(); i++) {
            val.push(null);
        }
        return val;
    }
    return [null];
};

var DimSelect = function(dataset, dim_name, dim_value) {
    this.dataset = dataset;
    this.selected_dim = ko.observable();
    this.show_options = ko.observable(false);
    this.dimensions = ko.observable();
    this.level_index = ko.observable(1);
    this.head_levels = ko.observable([]);
    this.tail_levels = ko.observable([]);
    this.prm = this.set_dimensions(
        dataset.available_dimensions(),
        dim_name,
        dim_value);

    this.choice = ko.computed(function() {
        var selected_dim = this.selected_dim();
        if (selected_dim && selected_dim.selected_coord()){
            return selected_dim.choice();
        }
        return this.dimensions();
    }.bind(this));

    this.label = ko.computed(function() {
        var dim = this.selected_dim();
        return dim ? dim.label : '?';
    }.bind(this));


    ko.computed(function() {
        var dim = this.selected_dim();
        if (!dim) {
            this.head_levels([]);
            this.tail_levels([]);
            return;
        }
        var heads = [];
        var tails = [];
        var depth = 0;
        var coord = dim.selected_coord();
        if (coord) {
            depth = coord.value.length;
        }

        dim.levels().slice(depth).forEach(function(name, pos) {
            var level = new Level(name, depth+pos, this);
            if (pos < 2) {
                heads.push(level);
            } else {
                tails.push(level);
            }
        }.bind(this));

        this.head_levels(heads);
        this.tail_levels(tails);
    }.bind(this));
};

DimSelect.prototype.set_dimensions = function(available, dim_name, dim_value) {
    var clones = available.map(function (d) {
        var clone = new Dimension(d.name, d.label, d.levels(), this);
        return clone
    }.bind(this));
    this.dimensions(clones);

    // Search the clone matching dim_name
    var clone = null;
    for (var pos in clones) {
        if (clones[pos].name == dim_name) {
            clone = clones[pos];
            break;
        }
    }

    // no match on dim_name: pick the first
    if (!clone) {
        clones[0].activate();
        return;
    }

    // update clone with the correct value and return the
    // corresponding promise
    clone.activate();
    var prm = clone.set_value(dim_value);
    return prm;
};

DimSelect.prototype.toggle_options = function(dim_select, ev) {
    this.show_options(!this.show_options());
};

DimSelect.prototype.drill_up = function() {
    this.selected_dim().drill_up();
    this.show_options(false);
};

DimSelect.prototype.can_drill_up = function() {
    return this.selected_dim().selected_coord();
};


var Level = function(name, index, dimsel) {
    this.name = name;
    this.index = index;
    this.dimsel = dimsel;

    if (dimsel.level_index() == index) {
        this.active = true;
    } else {
        this.active = false;
    }
};

Level.prototype.activate = function() {
    this.active = true;
    this.dimsel.level_index(this.index);
};


var DataSet = function(json_state) {
    this.measures =  ko.observableArray([]);
    this.available_measures = ko.observable([]);
    this.dim_selects = ko.observableArray([]);
    this.available_dimensions = ko.observable([]);
    this.data = ko.observable();
    this.columns = ko.observable([]);
    this.json_state = ko.observable();
    this.state = {};
    this.ready = ko.observable(false);

    // fetch meta-data and init state
    $.get('/mng/info.json').success(function(info) {
        this.set_info(info);
        this.set_state(json_state);
    }.bind(this));

    this.measures.subscribe(this.measures_changed.bind(this));

    // compute state
    ko.computed(this.refresh_state.bind(this)).extend({
        'rateLimit': 10,
    });
};

DataSet.prototype.push_dim_select = function() {
    var dsel = new DimSelect(this);
    this.dim_selects.push(dsel);
    return dsel;
};

DataSet.prototype.select_measure = function(selected, pos) {
    var msr = this.measures()
    msr[pos] = selected;
    this.measures(msr);
};

DataSet.prototype.push_measure = function() {
    this.measures.push(this.available_measures()[0]);
};

DataSet.prototype.pop_measure = function() {
    this.measures.pop();
};

DataSet.prototype.pop_dim_select = function() {
    this.dim_selects.pop()
};

DataSet.prototype.set_info = function(info) {
    for (var space_name in info) {
        var dimensions = [];
        for (var pos in info[space_name]['dimensions']) {
            var dim = info[space_name]['dimensions'][pos];
            dimensions.push(new Dimension(dim.name, dim.label, dim.levels));
        }
        DIM_CACHE[space_name] = dimensions;
    }

    var measures = [];
    for (var space_name in info) {
        var space = new Space(space_name, info[space_name]['label']);
        for (var pos in info[space_name]['measures']) {
            var msr = info[space_name]['measures'][pos];
            measures.push(new Measure(space, msr.name, msr.label));
        }
    }
    this.available_measures(measures);
};

DataSet.prototype.get_dim_selects = function(dims) {
    return dims.map(function(d) {
        return new DimSelect(this, d[0], d[1]);
    }.bind(this));
};

DataSet.prototype.measures_changed = function(measures) {
    var dimensions = DIM_CACHE[measures[0].space.name] || [];
    // Copy list to avoid destroying data
    dimensions = dimensions.slice();
    // Filter dimensions that are available for all measures
    for (var pos=1; pos < measures.length; pos++) {
        var others = DIM_CACHE[measures[pos].space.name]
        for (var x in dimensions) {
            var dim = dimensions[x];
            var found = false
            for (var y in others) {
                if (dim.name == others[y].name) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                dimensions.splice(x, 1);
            }
        }
    }

    this.available_dimensions(dimensions);
    this.refresh_dimensions();
};

DataSet.prototype.refresh_measures = function() {
    var measures = [];
    if (this.state.measures) {
        measures = this.available_measures().filter(function(m) {
            return this.state.measures.indexOf(m.name) >= 0;
        }.bind(this));
    } else if (this.available_measures().length) {
         measures = [this.available_measures()[0]];
    }
    this.measures(measures);
};

DataSet.prototype.refresh_dimensions = function() {
    // Clean active dimensions
    var current_selects = this.dim_selects();
    if (!current_selects) {
        current_selects = [];
    }

    var availables = {};
    this.available_dimensions().forEach(function(d) {
        availables[d.name] = d;
    });

    for (var pos in current_selects) {
        var current_select = current_selects[pos];
        var current_dim = current_select.selected_dim();
        var av_dim = availables[current_dim.name];
        if (!av_dim) {
            current_selects.splice(pos, 1);
        } else {
            current_select.set_dimensions(
                this.available_dimensions(),
                current_dim.name
            );
            current_dim.levels(av_dim.levels());
        }
    }

    // If dimensions remain, return ..
    if (current_selects.length) {
        this.dim_selects(current_selects)
        this.ready(true);
        return;
    }

    // .. if not, build them based on current state
    var state_dimensions = this.state.dimensions || [];
    state_dimensions = state_dimensions.filter(function(n) {
        return n[0] in availables;
    });
    if (state_dimensions.length) {
        var dim_selects = this.get_dim_selects(state_dimensions);
        // update this.dim_selects only when all are ready
        var prms = dim_selects.map(function(d) {return d.prm});
        $.when.apply(this, prms).then(function() {
            this.dim_selects(dim_selects);
            this.ready(true);
        }.bind(this));

    } else {
        // Show at least one dimension
        this.push_dim_select();
        this.ready(true);
    }
}

DataSet.prototype.set_state = function(state) {
    this.ready(false);
    this.state = state || {};
    // Reset data
    this.dim_selects([]);
    this.refresh_measures();
};

DataSet.prototype.refresh_state = function() {
    if (!this.ready()) {
        return;
    }

    var dim_sels = this.dim_selects();
    var msrs = this.measures();
    if (!(dim_sels.length && msrs.length)) {
        return;
    }

    this.state = {
        'measures': msrs.map(function(m) {return m.name}),
        'dimensions': dim_sels.map(function(dsel) {
            var dimension = dsel.selected_dim();
            var value = dimension.get_value();
            return [dimension.name, value]
        }),
    }
    this.json_state(JSON.stringify(this.state));

    var hash = '#' + encodeURIComponent(this.json_state());
    if (window.location.hash != hash) {
        window.history.pushState(this.state, "Title", hash);
    }
    this.fetch_data();
};

DataSet.prototype.fetch_data = function(mime) {
    var json_state = this.json_state()
    var res = DATA_CACHE[json_state];
    if (res && !mime) {
        this.data(res.data);
        this.columns(res.columns);
        return;
    }

    // Add empty value to prevent double-trigger of query
    DATA_CACHE[json_state] = {'data': []};

    var url = '/mng/dice.' + (mime || 'json') + '?' +  $.param({'query': json_state});;
    if (mime) {
        window.location.href = url;

    } else {
        $.ajax(url).success(this.set_data.bind(this, json_state))
    }
};

DataSet.prototype.set_data = function(json_state, res) {
    var msr_names = this.measures().map(function(m) {
        return m.name;
    });
    // var dim_names = this.dim_selects().map(function(dsel) {
    //     return d.selected_dim().name();
    // });
    var columns = res.columns;
    for (var x in res.data) {
        var line = res.data[x];
        for (var y in columns) {
            var c = columns[y];
            var val = line[y];
            if (c.type == 'dimension') {
                line[y] = val.join('/');
            } else if (c.type == 'measure') {
                if (val === undefined) {
                    line[y] = 0;
                } else if (val.toFixed) {
                    if (c.name.indexOf("amount") > -1) {
                    	if (c.name.indexOf("_eur") > -1) {
                    		var symbol = "€";
                    	} else {
                    		var symbol = "";
                    	}
                    	line[y] = to_money(val, symbol);
                    }
                }
            }
        }
    }

    // Store in cache
    DATA_CACHE[json_state] = res;
    this.data(res.data);
    this.columns(res.columns);
};

DataSet.prototype.get_xlsx = function() {
    this.fetch_data('xlsx');
};


var init = function() {
    var json_state;
    try {
        json_state = JSON.parse(
            decodeURIComponent(window.location.hash.slice(1))
        );
    } catch (err) {
        json_state = null;
    }

    var ds = new DataSet(json_state);
    window.onpopstate = function(event) {
        ds.set_state(event.state);
    }.bind(this);

    ko.applyBindings(ds, $('body')[0]);
};

$(init);
