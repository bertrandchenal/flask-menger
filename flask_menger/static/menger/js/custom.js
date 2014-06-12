"use strict"

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

var Dimension = function(name, label, depth, kw) {
    kw = kw || {};
    this.name = name;
    this.label = label;
    this.value = kw.value || [];
    this.parent = kw.parent;
    this.depth = depth;
    this.dim_select = ko.observable(kw.dim_select);
    this.active = ko.observable(false);
    this.children = [];
    this.fullname = label;
    if (this.value.length) {
        this.fullname = this.value[this.value.length-1];
    }
};

Dimension.prototype.drill = function(value) {
    // TODO add cache
    var query = {
        'space': this.dim_select().dataset.measures()[0].space.name,
        'dimension': this.name,
        'value': this.value,
    }

    query = JSON.stringify(query);
    var url = '/mng/drill.json?' + $.param({'query': query});

    var prm = $.ajax(url)
    prm.success(function(res) {
        this.add_children(res.data);
        this.activate();
        this.dim_select().selected(this);
    }.bind(this));
    return prm;
};

Dimension.prototype.add_children = function(names) {
    var children = [];
    for (var pos in names) {
        var name = names[pos];
        var value = this.value.slice();
        value.push(name);
        var child = this.clone({
            'value': value,
            'parent': this,
            'dim_select': this.dim_select(),
        });
        children.push(child);
    }
    this.children = children;
};

Dimension.prototype.clone = function(kw) {
    return new Dimension(
        this.name,
        this.label,
        this.depth,
        kw);
};

Dimension.prototype.set_value = function(value) {
    if (!value || !value.length) {
        return;
    }

    var prm = this.drill();
    if (!value[0]) {
        prm.success(function() {
            this.dim_select().selected(this);
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

Dimension.prototype.activate = function() {
    if (!this.parent) {
        this.dim_select().root(this);
    };
    if (this.active()) {
        this.active(false);
        return;
    }

    this.dim_select().choice().forEach(function(d) {
        d.active(false);
    }.bind(this))
    this.active(true);
};

Dimension.prototype.has_children = function() {
    return this.value.length < this.depth;
};

var DimSelect = function(dataset, dim_name, dim_value) {
    this.dataset = dataset;
    this.selected = ko.observable();
    this.root = ko.observable();
    this.available = ko.observable();
    this.prm = this.set_available(
        dataset.available_dimensions(),
        dim_name,
        dim_value);

    this.choice = ko.computed(function() {
        var selected = this.selected();
        if (selected){
            return selected.children;
        }
        return this.available();
    }.bind(this));

    this.label = ko.computed(function() {
        return this.root().label;
    }.bind(this));

    this.name = ko.computed(function() {
        return this.root().name;
    }.bind(this));

};

DimSelect.prototype.drill_up = function() {
    this.selected(this.selected().parent);
};

DimSelect.prototype.remove = function() {
    var idx = this.dataset.dimensions.indexOf(this);
    if (idx >= 0) {
        this.dataset.dimensions.splice(idx, 1);
    }
};

DimSelect.prototype.set_available = function(available, dim_name, dim_value) {
    var clones = available.map(function (d) {
        var clone = d.clone({dim_select: this});
        return clone
    }.bind(this));
    this.available(clones);

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
        this.root(clones[0]);
        clones[0].active(true);
        return;
    }

    // update clone with the correct value and return the
    // corresponding promise
    this.root(clone);
    var prm = clone.set_value(dim_value);
    return prm;
};

DimSelect.prototype.get_value = function() {
    var sel = this.selected();
    if (sel) {
        var actives = this.choice().filter(function(d) {
            return d.active();
        });
        if (actives.length) {
            return actives[0].value;
        }
        var val = sel.value.slice();
        val.push(null);
        return val;
    }
    return [null];
};

var DIM_CACHE = {}
var DATA_CACHE = {}

var DataSet = function(json_state) {
    this.measures =  ko.observableArray([]);
    this.available_measures = ko.observable([]);
    this.dimensions = ko.observableArray([]);
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

DataSet.prototype.push_dimension = function() {
    this.dimensions.push(new DimSelect(this));
};

DataSet.prototype.select_measure = function(selected, pos) {
    var msr = this.measures()
    msr[pos] = selected;
    this.measures(msr);
};

DataSet.prototype.push_measure = function() {
    this.measures.push(this.available_measures()[0]);
};

DataSet.prototype.remove_measure = function(pos) {
    this.measures.splice(pos);
};


DataSet.prototype.push_measure = function() {
    this.measures.push(this.available_measures()[0]);
};

DataSet.prototype.set_info = function(info) {
    for (var space_name in info) {
        var dimensions = [];
        for (var pos in info[space_name]['dimensions']) {
            var dim = info[space_name]['dimensions'][pos];
            dimensions.push(new Dimension(dim.name, dim.label, dim.depth));
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
        var other = DIM_CACHE[measures[pos].space.name]
        for (var x in dimensions) {
            var dname = dimensions[x].name;
            var found = false
            for (var y in other) {
                if (dname == other[y].name) {
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
    var current_dims = this.dimensions();
    if (!current_dims) {
        current_dims = [];
    }
    var available_names = this.available_dimensions().map(function(d) {
        return d.name;
    });
    for (var pos in current_dims) {
        var current_name = current_dims[pos].root().name;
        if (available_names.indexOf(current_name) < 0) {
            current_dims.splice(pos, 1);
        } else {
            current_dims[pos].set_available(
                this.available_dimensions()
            );
        }
    }

    // If dimensions remain, return ..
    if (current_dims.length) {
        this.dimensions(current_dims)
        this.ready(true);
        return;
    }

    // .. if not, build them based on current state
    var state_dimensions = this.state.dimensions || [];
    state_dimensions = state_dimensions.filter(function(n) {
        return available_names.indexOf(n[0]) >= 0;
    });
    if (state_dimensions.length) {
        var dimensions = this.get_dim_selects(state_dimensions);
        // update this.dimension only when all are ready
        var prms = dimensions.map(function(d) {return d.prm});
        $.when.apply(this, prms).then(function() {
            this.dimensions(dimensions);
            this.ready(true);
        }.bind(this));

    } else {
        // Show at least one dimension
        this.push_dimension();
        this.ready(true);
    }
}

DataSet.prototype.set_state = function(state) {
    this.ready(false);
    this.state = state || {};
    // Reset data
    this.dimensions([]);
    this.refresh_measures();
};

DataSet.prototype.refresh_state = function() {
    if (!this.ready()) {
        return;
    }

    var dims = this.dimensions();
    var msrs = this.measures();
    if (!(dims.length && msrs.length)) {
        return;
    }

    this.state = {
        'measures': msrs.map(function(m) {return m.name}),
        'dimensions': dims.map(function(d) {
            var value = d.get_value();
            return [d.name(), value]
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
    var dim_names = this.dimensions().map(function(d) {
        return d.name();
    });
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
